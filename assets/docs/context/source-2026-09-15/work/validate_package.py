from pathlib import Path
import json, re, math, zipfile, xml.etree.ElementTree as ET

root = Path('/Users/tomwu/Documents/Codex/2026-09-15/i-x20')
folder = root / 'outputs/contractor-platform'
expected = ['00-START-HERE.md', '01-business-plan.md', '02-codex-build-prompt.md', '03-roadmap-and-backlog.md', '04-financial-model.xlsx', '05-evidence-and-decisions.md']
assert sorted(p.name for p in folder.iterdir() if p.is_file()) == sorted(expected)
texts = {p.name: p.read_text() for p in folder.glob('*.md')}
for name, text in texts.items():
    assert not re.search(r'^(<<<<<<<|=======|>>>>>>>)', text, re.M), name
    for target in re.findall(r'\]\(([^)]+)\)', text):
        if '://' not in target and not target.startswith('#'):
            assert (folder / target.split('#')[0]).exists(), (name, target)
    assert text.count('```') % 2 == 0, name
ids = re.findall(r'^\| (CTP-\d+) \|', texts['03-roadmap-and-backlog.md'], re.M)
assert ids == [f'CTP-{i:03d}' for i in range(1, 26)], ids
prompt = texts['02-codex-build-prompt.md']
assert 'all IT contractor roles from day one' in prompt
assert 'two 60-minute monthly support allocations' in prompt
assert '30 days after pilot completion' not in prompt
assert 'Late acceptance cannot activate' in prompt
assert 'Human-led mock interviews use coaching credits' in prompt

data = json.loads((root/'work/financial-model.json').read_text())
c = data['common']
assert c['pilot_months'] + c['remaining_months'] == 12
assert c['pilot_price'] + c['remaining_price'] == c['first_year_price']
scenario_results = []
for sc in data['scenarios']:
    a = sc['assumptions']
    starts = a['starts']
    pilot_member_months = sum(n*min(2, 12-s) for s, n in enumerate(starts))
    expected_pilot_rev = pilot_member_months * 1500 * (1-a['pilot_refund'])
    expected_cont_rev = 0
    for s,n in enumerate(starts):
        eligible = n*(1-a['pilot_refund'])*a['conversion']
        for m in range(s+2, min(s+12,12)):
            expected_cont_rev += eligible*(1-a['early_release'])**(m-s-2)*900
    actual_revenue = sum(m['revenue'] for m in sc['months'])
    assert abs(expected_pilot_rev+expected_cont_rev-actual_revenue)<0.00001
    assert f'{round(actual_revenue):,}' in texts['01-business-plan.md']
    scenario_results.append({'case':a['name'], 'independent_revenue':round(expected_pilot_rev+expected_cont_rev,2), 'pilot_starts':sum(starts)})
for tier in data['tiers']:
    human = tier['coach']*125+tier['domain']*150+tier['implementation']*125+tier['engineer']*150+tier['senior']*200+tier['analyst']*80+tier['support']*60
    expected_direct = human+tier['ai']+tier['infra']+4*125/16+tier['annual']/12*0.029+0.3
    assert abs(expected_direct-tier['direct_monthly_cost'])<0.00001

ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
book=folder/'04-financial-model.xlsx'
with zipfile.ZipFile(book) as z:
    sheet_names=[s.attrib['name'] for s in ET.fromstring(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet',ns)]
    assert set(sheet_names)=={'Summary','Assumptions','Forecast','Cohorts','Unit economics'}
    for name in z.namelist():
        if name.startswith('xl/worksheets/sheet') and name.endswith('.xml'):
            tree=ET.fromstring(z.read(name))
            errors=[e.attrib.get('r') for e in tree.findall('.//s:c',ns) if e.attrib.get('t')=='e']
            assert not errors, (name,errors)
    assert not any(n.startswith('xl/externalLinks/') for n in z.namelist())

report={'files':expected,'issues':len(ids),'scenario_crosscheck':scenario_results,'workbook_sheets':sheet_names,'checks':'All package structure, pricing, pilot, cached formula error, and independent revenue checks passed. Native Excel was not tested.'}
(root/'work/package-validation.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
