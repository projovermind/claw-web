#!/usr/bin/env python3
"""GitHub SKILL.md → claw-web 스킬 수입 + 역할별 자동 배정 (idempotent, name 기준)."""
import json, re, sys, urllib.request, os
API='http://localhost:3838/api'; TOK=os.environ.get('CLAW_TOKEN','930214')
SRC='/tmp/claw-skills'
def call(m,p,b=None):
    r=urllib.request.Request(API+p,method=m,data=json.dumps(b).encode() if b is not None else None,
        headers={'Authorization':'Bearer '+TOK,'Content-Type':'application/json'})
    with urllib.request.urlopen(r) as x: return json.loads(x.read() or b'{}')
def load(slug):
    t=open(f'{SRC}/{slug}/SKILL.md',encoding='utf8').read()
    m=re.match(r'^---\n(.*?)\n---\n',t,re.S); desc=''
    if m:
        fm=m.group(1); t=t[m.end():]
        d=re.search(r'^description:\s*(.+)$',fm,re.M); desc=d.group(1).strip().strip('"\'') if d else ''
    t=re.sub(r'superpowers:([a-z-]+)',r"'\1' 스킬",t)
    t=re.sub(r'\$\{CLAUDE_PLUGIN_ROOT\}[^\s)]*','(생략)',t)
    return desc[:500], t.strip()
# (slug, 표시이름, source, alwaysOn, triggers, priority, 대상)
S=[
 ('sp-verification-before-completion','verification-before-completion','obra/superpowers',True,[],900,'all'),
 ('karpathy','karpathy-guidelines','multica-ai/andrej-karpathy-skills',True,[],900,'all'),
 ('git-commit-brigade','git-commit','spinabot/brigade',False,['commit','커밋','pull request','PR ','push','푸시'],500,'all'),
 ('sp-test-driven-development','test-driven-development','obra/superpowers',False,['TDD','test-driven','테스트 주도','테스트 먼저','테스트부터'],400,'coder'),
 ('sp-systematic-debugging','systematic-debugging','obra/superpowers',False,['버그','bug','디버깅','debug','에러 원인','원인 파악','failing','crash','안 돼','안됨','재현'],400,'coder'),
 ('sp-condition-based-waiting','condition-based-waiting','obra/superpowers-skills',False,['flaky','간헐','setTimeout','sleep(','waitFor','타이밍','race'],300,'coder'),
 ('vitest-secondsky','vitest-testing','secondsky/claude-skills',False,['vitest','테스트 작성','테스트 추가','mock','coverage','supertest'],300,'coder'),
 ('ja-typescript-pro','typescript-pro','Jeffallan/claude-skills',False,['TypeScript','타입 에러','tsc','generic','제네릭','타입 정의','type error'],300,'coder'),
 ('ja-security-reviewer','security-reviewer','Jeffallan/claude-skills',False,['보안','security','취약점','OWASP','XSS','injection','인젝션','인증 우회','CSRF'],300,'coder'),
 ('ja-websocket-engineer','websocket-engineer','Jeffallan/claude-skills',False,['WebSocket','websocket',' ws ','socket','실시간','재연결','broadcast'],300,'server'),
 ('ja-react-expert','react-expert','Jeffallan/claude-skills',False,['React','tsx','컴포넌트','useEffect','useState','hook','렌더링','리렌더'],300,'client'),
 ('an-frontend-design','frontend-design','anthropics/skills',False,['디자인','UI 디자인','레이아웃','룩앤필','랜딩','시각적','미려'],300,'client'),
 ('an-webapp-testing','webapp-testing','anthropics/skills',False,['playwright','e2e','스크린샷','브라우저 테스트','UI 확인','화면 확인'],300,'tester'),
 ('sp-brainstorming','brainstorming','obra/superpowers',False,['브레인스토밍','brainstorm','기획','요구사항','설계안','새 기능 제안','spec'],400,'planner'),
 ('sp-writing-plans','writing-plans','obra/superpowers',False,['계획서','구현 계획','implementation plan','로드맵','작업 분해','플랜 작성'],400,'planner'),
 ('sp-finishing-a-development-branch','finishing-a-development-branch','obra/superpowers',False,['머지','merge','브랜치 정리','릴리즈','release','배포 준비'],300,'release'),
]
agents=[a['id'] for a in call('GET','/agents')['agents']]
def role(aid):
    r=set(['all'])
    if re.search(r'planner|router|assistant|general|hivemind|default|^blog_',aid): 
        if 'planner' in aid: r|={'planner','release'}
        return r
    r|={'coder'}
    if re.search(r'server|api|core|pipeline|storage|data|settlement|records',aid): r|={'server'}
    if re.search(r'client|frontend|dashboard|drawing|chart|user|content|report',aid): r|={'client'}
    if re.search(r'tester|client|frontend|dashboard',aid): r|={'tester'}
    if re.search(r'release',aid): r|={'release'}
    return r
existing={s['name']:s for s in call('GET','/skills')['skills']}
summary=[]
for slug,name,src,always,trig,prio,target in S:
    desc,content=load(slug)
    content=f"<!-- source: github.com/{src} -->\n"+content
    if name in existing: sk=existing[name]; action='기존'
    else:
        sk=call('POST','/skills',{'name':name,'description':desc or name,'content':content,'triggers':trig,'alwaysOn':always,'priority':prio}); action='생성'
    ids=[a for a in agents if target in role(a)]
    r=call('POST',f"/skills/{sk['id']}/assign",{'agentIds':ids})
    summary.append(f"{action} {name:34s} {'always' if always else 'trig':6s} tok≈{len(content)//4:5d} → {len(ids):2d} agents resp={str(r)[:60]}")
print('\n'.join(summary))
