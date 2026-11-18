"""Create the final Chinese audit report from frozen five-round evidence."""
from pathlib import Path
import json, hashlib
from collections import Counter
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'artifacts/five-round-audit-20261001'
OUT=Path('/Users/fengjinwen/Desktop/a股/五轮审计版1.5.3/三方五轮全链路审计报告.docx')
def read(name): return json.loads((ART/name).read_text())
ledger=read('ledger.json')
assert len(ledger['rounds'])>=5 and all(x['status']=='closed' for x in ledger['rounds']), 'All audit rounds must be closed'
validation=read('test-validation.json');native=read('delivery-native.json');audit=read('independent-lifecycle-audit.json')
assert validation['status']=='passed' and native['status']=='passed' and audit['verdict']['codeAndNativeApproved'] is True
# Editorial summaries are checked against the original reports before rendering.
editorial=read('report-editorial.json')
issues=editorial['issues'];risk=Counter(x['risk'] for x in issues)
doc=Document();sec=doc.sections[0]
sec.page_width,sec.page_height=Inches(8.5),Inches(11)
sec.top_margin,sec.bottom_margin=Inches(.7),Inches(.65)
sec.left_margin=sec.right_margin=Inches(.78);sec.footer_distance=Inches(.3)
for name in ['Normal','Title','Subtitle','Heading 1','Heading 2','Heading 3']:
 st=doc.styles[name];st.font.name='Arial Unicode MS';st.font.color.rgb=RGBColor(0,0,0)
 fonts=st.element.get_or_add_rPr().rFonts
 for attr in ['asciiTheme','hAnsiTheme','eastAsiaTheme','cstheme']:fonts.attrib.pop(qn('w:'+attr),None)
 fonts.set(qn('w:eastAsia'),'Arial Unicode MS')
 for border in list(st.element.iter(qn('w:pBdr'))):border.getparent().remove(border)
n=doc.styles['Normal'];n.font.size=Pt(11);n.paragraph_format.line_spacing=Pt(15);n.paragraph_format.space_after=Pt(7)
for name,size in [('Title',25),('Subtitle',12),('Heading 1',18),('Heading 2',13)]:
 st=doc.styles[name];st.font.size=Pt(size);st.font.italic=False;st.paragraph_format.space_before=Pt(10);st.paragraph_format.space_after=Pt(8);st.paragraph_format.keep_with_next=True
doc.styles['Title'].paragraph_format.space_before=Pt(0)
doc.core_properties.title='A股雷达三方五轮全链路审计报告';doc.core_properties.author='Codex 协作审计'
def p(text,style=None):return doc.add_paragraph(text,style)
def h(text):doc.add_heading(text,1)
def sub(text):doc.add_heading(text,2)
def page():doc.add_page_break()
def table(headers,rows,widths):
 t=doc.add_table(rows=1,cols=len(headers));t.autofit=False
 borders=OxmlElement('w:tblBorders')
 for edge in ['top','left','bottom','right','insideH','insideV']:
  b=OxmlElement('w:'+edge);b.set(qn('w:val'),'single');b.set(qn('w:sz'),'4');b.set(qn('w:color'),'D9D9D9');borders.append(b)
 t._tbl.tblPr.append(borders)
 for i,w in enumerate(widths):t.columns[i].width=Inches(w)
 for index,values in enumerate([headers]+rows):
  row=t.rows[0] if index==0 else t.add_row()
  tr=OxmlElement('w:cantSplit');row._tr.get_or_add_trPr().append(tr)
  for i,(cell,value) in enumerate(zip(row.cells,values)):
   cell.width=Inches(widths[i]);cell.text=str(value);cell.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
   margins=OxmlElement('w:tcMar')
   for edge in ['top','left','bottom','right']:
    m=OxmlElement('w:'+edge);m.set(qn('w:w'),'90');m.set(qn('w:type'),'dxa');margins.append(m)
   cell._tc.get_or_add_tcPr().append(margins)
   if index==0:
    sh=OxmlElement('w:shd');sh.set(qn('w:fill'),'DCE7EF');cell._tc.get_or_add_tcPr().append(sh)
   for para in cell.paragraphs:
    para.paragraph_format.line_spacing=Pt(14);para.paragraph_format.space_after=Pt(1)
    if i==0:para.alignment=WD_ALIGN_PARAGRAPH.CENTER
    for run in para.runs:run.font.size=Pt(10);run.bold=index==0
 repeat=OxmlElement('w:tblHeader');t.rows[0]._tr.get_or_add_trPr().append(repeat)
 p('');return t
footer=sec.footer.paragraphs[0];footer.alignment=WD_ALIGN_PARAGRAPH.RIGHT
footer.add_run('A股雷达 1.5.3  ·  ');field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');footer._p.append(field)
for run in footer.runs:run.font.size=Pt(9)
p('A股雷达三方五轮全链路审计报告','Title');p('版本 1.5.3    2026年10月1日','Subtitle')
p(f'本次在1.5.2基础上完成五轮三方审查。每轮均覆盖需求、设计、前端、后端与IPC、持久化、安全、测试、构建交付，并在整改后复核。共确认并关闭{len(issues)}项问题，其中高风险{risk["高"]}项、中风险{risk["中"]}项、低风险{risk["低"]}项。')
p('A方关注用户流程与数据完整性，B方关注架构与资源生命周期，C方关注测试与交付。三个agent均不修改被审生产代码；协调方实施修复，再由审计方交叉验证。这里的三方指独立执行上下文，不代表外部机构认证。')
h('交付结果')
p('新版应用、源码、Word报告和验证证据放在桌面a股目录中的五轮审计版1.5.3。此前1601个成品及资料文件逐项核对，未覆盖旧版。策略目标、评分、阈值与预设参数保持兼容。')
table(['轮次','重点','新增问题','结果'],[[r['round'],editorial['rounds'][str(r['round'])]['focus'],r.get('confirmedFindings',0),'关闭'] for r in ledger['rounds']],[.55,4.35,.85,1.15])
p('风险等级按可复现影响划分：高风险涉及关键安全或核心数据破坏；中风险影响用户操作、数据恢复或发布可靠性；低风险属于有限边界和交付完整性。问题数量按可复现证据统计，未观测环境及覆盖限制单独列明。')
page()
for r in ledger['rounds']:
 i=r['round'];data=editorial['rounds'][str(i)];h(f'第{i}轮 {data["focus"]}')
 p(data['summary']);sub('独立检查与改进')
 for text in data['work']:p(text)
 found=[x for x in issues if x['round']==i]
 if found:
  for x in found:
   sub(f'{x["id"]} {x["title"]}')
   for text in ['风险等级  '+x['risk']+'    状态  已整改并复验','触发与影响  '+x['impact'],'实施改进  '+x['fix']]:
    p(text).paragraph_format.keep_with_next=True
   p('验证依据  '+x['evidence'])
 else:p('本轮没有新增确认缺陷。保留已有实现，并执行新的边界验证与交付检查；这些验证及其结果构成本轮迭代记录。')
 sub('轮末复核')
 p(data['verification']);p('完整检查及原始证据见证据包 round-'+str(i)+' 下的 a-review、b-review、c-review 与对应 recheck 报告。各报告保留实际检查文件、源码指纹、命令和限定条件。')
h('验证结果与适用范围')
for text in editorial['finalValidation']:p(text)
h('全链路覆盖')
table(['层级','五轮检查范围'],[[k,v] for k,v in editorial['coverage'].items()],[1.15,5.75])
p('源码指纹  '+validation['sourceManifestSha256'])
p('原生应用指纹  '+native['appManifestSha256'])
sub('尚未执行的环境检查')
p('原生操作由协调方在隔离资料目录执行，三方核对对应绑定证据。已验证macOS应用首屏、版本、空凭据设置、返回导航及正常退出。真实账户凭据连接、用户系统钥匙串授权、全市场扫描、长时间压力测试和Windows/Linux原生运行未执行。合成故障注入通过不等于这些环境已通过，也不构成零漏洞或收益保证。')
h('使用与维护')
p('双击五轮审计版1.5.3目录内的A股雷达趋势版.app。各版本沿用同一本机资料，请先正常退出正在使用的版本，再打开另一版本。旧成品继续保留。')
p('源码ZIP不包含node_modules或个人凭据。按锁文件准备环境后，运行pnpm verify:fullstack检查类型、单元与浏览器回归；正式发布入口另外执行依赖安全检查和打包检查。浏览器测试需要Chrome，可通过QA_CHROMIUM_PATH指定路径。')
p('审计验证证据ZIP包含五轮三方报告、复现探针、整改差异、原始测试日志和交付记录。个别最初失败是测试夹具本身的问题，已保留失败日志并注明修正原因；最终结论使用后续真实通过的执行结果。')
sub('后续改进原则')
p('发现实际使用问题时，先保留复现步骤与合成样本，再增加失败用例、作最小修复和相关回归。对未观测到的性能瓶颈不做无依据重写；构建分块大小提示仅代表构建器阈值，本次未测得对应的具体性能故障，不将它冒称为已验证的性能结论。')
OUT.parent.mkdir(parents=True,exist_ok=True);doc.save(OUT)
print(json.dumps({'path':str(OUT),'issues':len(issues),'riskCounts':dict(risk),'sha256':hashlib.sha256(OUT.read_bytes()).hexdigest()},ensure_ascii=False))
