/**
 * Session Analyzer — chat.done 이벤트 구독, 세션 분석 후 메모리/CARL 룰 자동 학습
 *
 * 흐름:
 *   chat.done → 5초 딜레이 → 마지막 50개 메시지 읽기
 *   → Claude subprocess로 패턴 분석 → JSON { memories[], carlRules[] }
 *   → memory-writer.js + carl-auto-learner.js 에 위임
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { writeMemories } from './memory-writer.js';
import { learnCarlRules } from './carl-auto-learner.js';

// Claude CLI 경로 탐지 (claude-cli-runner.js와 동일한 로직)
function findClaudeBin() {
  const candidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}

const CLAUDE_BIN = findClaudeBin();

const ANALYSIS_PROMPT = `다음 대화를 분석하여 반복 실수 패턴과 성공 패턴을 추출하세요.
결과는 반드시 JSON 형식으로만 반환하세요 (코드블록, 설명 텍스트 없이 순수 JSON만):

{
  "memories": [
    {
      "type": "feedback",
      "name": "짧은 식별 이름",
      "description": "한줄 요약 (미래 대화에서 이 메모리가 필요한지 판단하는 기준)",
      "content": "상세 내용 (마크다운 가능)"
    }
  ],
  "carlRules": [
    {
      "domain": "도메인명 (예: coding, testing, communication)",
      "rule": "규칙 텍스트 (Claude가 지켜야 할 행동)",
      "confidence": 0.85,
      "recall": ["트리거 키워드1", "키워드2"]
    }
  ]
}

분석 기준:
- memories: 이 대화에서 드러난 사용자 선호/교정/반복 패턴만 추출 (코드 내용이나 단순 사실은 제외)
- carlRules: 미래 대화에 자동 적용할 만한 행동 규칙, confidence는 패턴 강도 (0.8 미만은 제외 권장)
- 패턴이 없으면 빈 배열 반환: { "memories": [], "carlRules": [] }

대화:
`;

/**
 * Claude -p 로 분석 실행, stdout JSON 반환
 * @param {string} prompt
 * @param {string|null} workingDir
 * @returns {Promise<string|null>}
 */
function runClaudeAnalysis(prompt, workingDir) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'text', '--model', 'claude-haiku-4-5-20251001'];

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin'];
    if (cleanEnv.PATH && !cleanEnv.PATH.includes('/usr/local/bin')) {
      cleanEnv.PATH = extraPaths.join(':') + ':' + cleanEnv.PATH;
    }

    const spawnOpts = {
      env: cleanEnv,
      cwd: workingDir || process.env.HOME,
    };

    let stdout = '';
    let stderr = '';

    const proc = spawn(CLAUDE_BIN, args, spawnOpts);

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        logger.debug({ code, stderr: stderr.slice(0, 200) }, 'session-analyzer: claude exited non-zero');
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err) => {
      logger.debug({ err: err.message }, 'session-analyzer: claude spawn error');
      resolve(null);
    });

    // 60초 타임아웃
    setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      resolve(null);
    }, 60000);
  });
}

/**
 * @param {object} opts
 * @param {import('./event-bus.js').EventBus} opts.eventBus
 * @param {object} opts.sessionsStore
 * @param {object} opts.configStore
 */
export function createSessionAnalyzer({ eventBus, sessionsStore, configStore }) {
  const unsub = eventBus.subscribe(({ topic, payload }) => {
    if (topic !== 'chat.done') return;
    const { sessionId } = payload;

    setTimeout(() => {
      analyzeSession(sessionId).catch((err) => {
        logger.debug({ err: err.message, sessionId }, 'session-analyzer: unexpected error (non-fatal)');
      });
    }, 5000);
  });

  async function analyzeSession(sessionId) {
    try {
      const session = sessionsStore.get(sessionId);
      if (!session) return;

      const messages = (session.messages || []).slice(-50);
      // 최소 4개 (user 2턴 + assistant 2턴) 이상이어야 의미 있음
      if (messages.length < 4) return;

      const agent = configStore.getAgent(session.agentId);
      const workingDir = agent?.workingDir || null;

      // 대화 텍스트 직렬화
      const convText = messages
        .map((m) => {
          const role = m.role === 'user' ? '[User]' : '[Assistant]';
          const content =
            typeof m.content === 'string'
              ? m.content.slice(0, 2000)
              : JSON.stringify(m.content).slice(0, 2000);
          return `${role}: ${content}`;
        })
        .join('\n\n');

      const prompt = ANALYSIS_PROMPT + convText;
      const raw = await runClaudeAnalysis(prompt, workingDir);
      if (!raw) return;

      // JSON 블록 추출 (```json ... ``` 또는 순수 { ... })
      let jsonStr = raw;
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        jsonStr = fenceMatch[1];
      } else {
        const objMatch = raw.match(/\{[\s\S]*\}/);
        if (objMatch) jsonStr = objMatch[0];
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (err) {
        logger.debug({ err: err.message, raw: raw.slice(0, 200) }, 'session-analyzer: JSON parse failed');
        return;
      }

      const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
      const carlRules = Array.isArray(parsed.carlRules) ? parsed.carlRules : [];

      if (memories.length === 0 && carlRules.length === 0) return;

      logger.info(
        { sessionId, memories: memories.length, carlRules: carlRules.length, workingDir },
        'session-analyzer: analysis complete'
      );

      // 병렬로 저장
      await Promise.allSettled([
        workingDir && memories.length > 0 ? writeMemories(workingDir, memories) : Promise.resolve(),
        workingDir && carlRules.length > 0 ? learnCarlRules(workingDir, carlRules) : Promise.resolve(),
      ]);
    } catch (err) {
      logger.debug({ err: err.message, sessionId }, 'session-analyzer: analyzeSession failed (non-fatal)');
    }
  }

  return {
    close() {
      unsub();
    }
  };
}
