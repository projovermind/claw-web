/**
 * Terraform Scanner — 기존 개발 환경 자동 발견
 *
 * 1. 파일시스템 스캔: .git / package.json / CLAUDE.md / pyproject.toml 등 마커
 * 2. 기존 Claude 도구 흡수: discord-bot config, claude-code projects, carl.json
 * 3. CLAUDE.md 분석 → 프로젝트 메타 (이름, 설명, 색상) 추출
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

// 프로젝트 마커 파일들
const PROJECT_MARKERS = [
  'CLAUDE.md',        // 우선순위 최상
  'AGENTS.md',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json'
];

// 스캔 제외 디렉토리
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'target', 'dist', 'build',
  '.next', '.nuxt', 'venv', '.venv', '__MACOSX', '.cache', '.vscode',
  'Library', 'System', 'bin', 'Applications'
]);

/**
 * 지정 경로에서 depth까지 프로젝트 후보 스캔
 */
export function scanDirectories(rootPaths, maxDepth = 4) {
  const found = [];
  const seen = new Set();

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (seen.has(dir)) return;
    seen.add(dir);

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    // 이 디렉토리에 프로젝트 마커가 있는지 체크
    const markers = entries
      .filter(e => e.isFile() && PROJECT_MARKERS.includes(e.name))
      .map(e => e.name);

    if (markers.length > 0) {
      found.push({
        path: dir,
        name: path.basename(dir),
        markers,
        hasClaude: markers.includes('CLAUDE.md'),
        priority: markers.includes('CLAUDE.md') ? 10 :
                  markers.includes('AGENTS.md') ? 8 : 5
      });
      // 프로젝트 찾으면 그 하위는 탐색 안 함 (중첩 프로젝트 방지)
      return;
    }

    // 하위 디렉토리 재귀
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }

  for (const root of rootPaths) {
    if (!fs.existsSync(root)) continue;
    try {
      const stat = fs.statSync(root);
      if (stat.isDirectory()) walk(root, 0);
    } catch { /* skip */ }
  }

  // 우선순위 + 이름 정렬
  return found.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

/**
 * CLAUDE.md 파싱 — 프로젝트 메타 추출
 */
export function parseClaudeMd(projectPath) {
  const mdPath = path.join(projectPath, 'CLAUDE.md');
  if (!fs.existsSync(mdPath)) return null;
  try {
    const content = fs.readFileSync(mdPath, 'utf8');
    const lines = content.split('\n');
    // 첫 번째 `# 제목` 추출
    const titleLine = lines.find(l => l.startsWith('# '));
    const title = titleLine?.replace(/^#\s+/, '').trim();
    // `## 개요` 다음 내용 요약
    let description = '';
    const overviewIdx = lines.findIndex(l => /^##\s*(개요|Overview|About)/i.test(l));
    if (overviewIdx !== -1) {
      const after = lines.slice(overviewIdx + 1, overviewIdx + 5).join(' ').trim();
      description = after.slice(0, 200);
    }
    return { title: title || path.basename(projectPath), description, contentLength: content.length };
  } catch { return null; }
}

/**
 * 기존 Claude 생태계 도구 흡수
 */
export function detectExistingTools() {
  const home = process.env.HOME || '';
  const tools = {};

  // 1. claude-discord-bot
  for (const candidate of [
    '/Volumes/Core/claude-discord-bot/config.json',
    path.join(home, '.claude-discord-bot/config.json'),
    path.join(home, 'claude-discord-bot/config.json')
  ]) {
    if (fs.existsSync(candidate)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        tools.discordBot = {
          path: candidate,
          agentCount: Object.keys(cfg.agents || {}).length,
          agents: Object.keys(cfg.agents || {})
        };
      } catch { /* skip */ }
      break;
    }
  }

  // 2. Claude Code projects
  const claudeProjectsDir = path.join(home, '.claude', 'projects');
  if (fs.existsSync(claudeProjectsDir)) {
    try {
      const projs = fs.readdirSync(claudeProjectsDir)
        .filter(name => {
          const p = path.join(claudeProjectsDir, name);
          try { return fs.statSync(p).isDirectory(); } catch { return false; }
        });
      tools.claudeCode = { path: claudeProjectsDir, projectCount: projs.length };
    } catch { /* skip */ }
  }

  // 3. CARL
  const carlPath = path.join(home, '.carl', 'carl.json');
  if (fs.existsSync(carlPath)) {
    try {
      const carl = JSON.parse(fs.readFileSync(carlPath, 'utf8'));
      tools.carl = {
        path: carlPath,
        domainCount: Object.keys(carl.domains || {}).length,
        domains: Object.keys(carl.domains || {})
      };
    } catch { /* skip */ }
  }

  // 4. PAUL (.paul/ 디렉토리)
  const paulDir = path.join(home, '.paul');
  if (fs.existsSync(paulDir)) tools.paul = { path: paulDir };

  return tools;
}

/**
 * 프로젝트에 자동 에이전트 세트 생성 (기획자 + 라우터)
 */
export function generateDefaultAgents(projectId, projectName) {
  const prefix = projectId.toLowerCase().replace(/-/g, '_');
  return [
    {
      id: `${prefix}_planner`,
      name: `${projectName} 기획자`,
      avatar: '📋',
      model: 'sonnet',
      systemPrompt: `당신은 ${projectName} 프로젝트의 기획자입니다.\n\n## 역할\n- 요구사항 분석\n- 작업을 세부 에이전트에게 위임\n- 진행 상황 관리\n\n## 제약\n- 직접 코드 작성은 하지 않습니다 (라우터/개발자에게 위임)\n- Read/Grep/Glob으로 코드베이스 파악만 수행`,
      tier: 'project',
      projectId,
      allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite', 'Agent'],
      disallowedTools: ['Write', 'Edit', 'Bash', 'NotebookEdit']
    }
  ];
}

/**
 * 스캔 + 흡수 결과를 하나의 보고서로
 */
export async function fullTerraformScan(rootPaths) {
  const projects = scanDirectories(rootPaths);
  const tools = detectExistingTools();

  // 각 프로젝트의 CLAUDE.md 파싱
  for (const p of projects) {
    if (p.hasClaude) {
      const meta = parseClaudeMd(p.path);
      if (meta) {
        p.title = meta.title;
        p.description = meta.description;
      }
    }
  }

  logger.info({ projectCount: projects.length, tools: Object.keys(tools) }, 'terraform: scan complete');
  return { projects, tools };
}
