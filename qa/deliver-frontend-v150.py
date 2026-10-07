"""Deliver the redesigned frontend separately while retaining the user's 1.4.6 release."""
from pathlib import Path
import datetime, hashlib, json, re, shutil, subprocess, sys, zipfile
repo = Path(__file__).resolve().parents[1]
checks = repo / 'artifacts/frontend-v150'
base = Path('/Users/fengjinwen/Desktop/a股')
preserved = base / '改版前保留_1.4.6'
destination = base / '重构版1.5.0'
app = repo / 'release-builder/mac-arm64/A股雷达趋势版.app'
resources = app / 'Contents/Resources/app'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
mode = sys.argv[1]
assert mode in ('install', 'finalize')
version = json.loads((repo / 'package.json').read_text())['version']
assert version == '1.5.0'
assert json.loads((resources / 'package.json').read_text())['version'] == version
assert json.loads((preserved / app.name / 'Contents/Resources/app/package.json').read_text())['version'] == '1.4.6'
assert sha(base / 'a-stock-radar-tader源码.zip') == sha(preserved / 'a-stock-radar-tader源码.zip'), 'Original source must remain intact'
for name in ['typecheck.log', 'typecheck-review.log']:
    assert not (checks / name).read_text(), name
for p in [checks / 'root-focused.tap', checks / 'frontend-ui.tap', checks / 'watch-regression.tap', repo / 'artifacts/frontend-v150-research-green.tap']:
    assert re.search(r'(?:#|ℹ) fail 0\b', p.read_text()), p
production = [p for p in (repo / 'electron').glob('*.cjs') if not p.name.endswith('.test.cjs') and not p.name.startswith(('build-', 'deploy-'))]
production += list((repo / 'config').glob('*.json'))
production += [p for p in (repo / 'dist').rglob('*') if p.is_file()]
for p in production:
    assert sha(p) == sha(resources / p.relative_to(repo)), p
if mode == 'install':
    destination.mkdir(exist_ok=True)
    target = destination / app.name
    commands = subprocess.check_output(['ps','-axo','command='],text=True).splitlines()
    for installed in [base / app.name,target]:
        executable = str(installed / 'Contents/MacOS/A股雷达趋势版')
        assert not any(command.strip() == executable or command.strip().startswith(executable + ' ') for command in commands), 'Quit running app before starting the new release'
    assert not target.exists(), 'Separate destination already exists; do not overwrite an unknown app'
    shutil.copytree(app, target, symlinks=True)
else:
    for p in production:
        assert sha(p) == sha(destination / app.name / 'Contents/Resources/app' / p.relative_to(repo)), p
    files = set()
    for root in ['src','electron','qa','docs','assets','config']:
        files.update(p for p in (repo / root).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.name != '.DS_Store')
    files.update(p for p in repo.iterdir() if p.is_file() and (p.suffix in ['.json','.yaml','.yml','.ts','.md','.html','.cmd','.ico','.png'] or p.name in ['.gitignore','LICENSE','.npmrc']))
    source_zip = destination / 'a-stock-radar-tader源码.zip'
    with zipfile.ZipFile(source_zip,'w',zipfile.ZIP_DEFLATED) as archive:
        for p in sorted(files): archive.write(p, Path('a-stock-radar-tader') / p.relative_to(repo))
    with zipfile.ZipFile(source_zip) as archive:
        assert archive.testzip() is None
        assert json.loads(archive.read('a-stock-radar-tader/package.json'))['version'] == version
        for p in (repo / 'src').glob('*'):
            if p.is_file(): assert hashlib.sha256(archive.read('a-stock-radar-tader/'+str(p.relative_to(repo)))).hexdigest() == sha(p)
    (destination / '先读我.txt').write_text('''A股雷达趋势版 1.5.0 · 前端重构版

双击本文件夹中的 A股雷达趋势版.app 使用。
旧版1.4.6仍在a股根目录，并完整保留于“改版前保留_1.4.6”；未覆盖旧应用和源码。

本版调整
1. 全局统一紧凑导航、搜索工具栏、标题、表格、配色和响应式布局。
2. 趋势候选改为结果表，点击“详情 / 计划”展开规则和计算器，保留草稿。
3. 策略信号使用策略目录+股票主表，指定股票测试、规则与验证证据均可展开。
4. 自选采用监控列表；持仓采用录入区+明细表；板块左侧查询、右侧成员。
5. 资讯采用筛选栏+消息流；来源状态与判定规则可展开。
6. 设置分为行情连接、监控与提醒、执行参数、策略组合；切换分类保留未保存草稿。
7. 专业复盘、组合回测和多股同列重新安排证据、参数、图表与结果区域。

策略、业务数据和监控规则沿用原实现。现有深浅主题与本机数据继续使用。
新旧版使用同一应用数据目录，请先正常退出其中一个再打开另一个。
本轮进行了页面布局和交互回归检查，没有启动长时稳定性任务。
''')
    manifest={'version':version,'deliveredAt':datetime.datetime.now().isoformat(),'destination':str(destination),'preservedVersion':'1.4.6','preservedPath':str(preserved),'packagedFilesVerified':len(production),'sourceSha256':sha(source_zip)}
    (checks / 'delivery.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
print(json.dumps({'version':version,'mode':mode,'destination':str(destination),'packagedFilesVerified':len(production)},ensure_ascii=False))
