const $=id=>document.getElementById(id);
const fmt=x=>Number(x).toLocaleString('ko-KR',{maximumFractionDigits:3});
let worker, nextId=0, requests=new Map(), sectors=[], rowChoices=[], cells=[], basket=[], result=null;
let barMetric='production', linkages=[], hmData=null, hmCustomList=[];

function text(tag,value){const e=document.createElement(tag);e.textContent=value;return e;}
function call(type,payload){return new Promise((resolve,reject)=>{const id=++nextId;requests.set(id,{resolve,reject});worker.postMessage({id,type,payload});});}
function startWorker(){
  worker=new Worker('./worker.js');
  worker.onmessage=({data:d})=>{
    if(d.type==='status'){$('status').textContent=d.text;return;}
    const p=requests.get(d.id);if(!p)return;requests.delete(d.id);
    d.ok?p.resolve(d.result):p.reject(Error(d.error));
  };
  worker.onerror=e=>{for(const p of requests.values())p.reject(Error(e.message||'Worker 실행 오류'));requests.clear();};
}
function options(el,list){
  el.replaceChildren(...list.map(x=>{
    const o=document.createElement('option');
    o.value=x.code;
    o.textContent=x.code+' '+x.name;
    return o;
  }));
}
function invalidate(){result=null;$('results').hidden=true;}

const CONTROLS = [
  'sheet','row','sector','add','run','row-search','col-search','sector-search','amount',
  'hm-sheet','hm-mode','hm-top-n','hm-scale','hm-search','hm-sector-select','hm-add-sector','hm-reset-sector',
  'linkage-search','linkage-sort'
];

async function load(buffer){
  invalidate();basket=[];renderBasket();
  for(const id of CONTROLS) if($(id)) $(id).disabled=true;
  if(worker)worker.terminate();
  for(const p of requests.values())p.reject(Error('데이터 다시 로드'));
  requests.clear();startWorker();
  try{
    const info=await call('init',buffer);
    sectors=info.sectors;
    linkages=info.linkages||[];
    options($('sector'),sectors);
    options($('hm-sector-select'),sectors);
    $('sector-search').value='';$('row-search').value='';$('col-search').value='';
    $('sheet').replaceChildren(...info.sheets.map(s=>{const o=text('option',s);o.value=s;return o;}));

    const amountSheets = info.amountSheets && info.amountSheets.length ? info.amountSheets : info.sheets;
    $('hm-sheet').replaceChildren(...amountSheets.map(s=>{const o=text('option',s);o.value=s;return o;}));

    $('validation').textContent=JSON.stringify(info.residuals,null,2)+'\n최대 절대 잔차: 허용값 1e-8 미만';
    for(const id of CONTROLS) if($(id)) $(id).disabled=false;

    // 기본 관심 산업 프리셋 8개 미리 세팅
    hmCustomList = sectors.slice(0, 8).map(s=>s.code);
    renderHmTags();

    await explore();
    await loadHeatmap();
    renderLinkages();

    $('status').textContent='준비 완료 · '+sectors.length+'개 부문 · '+info.sheets.length+'개 시트 · 계수 검증 통과';
  }catch(e){
    $('status').textContent='준비 실패: '+e.message+' — 새로고침 후 재시도하세요.';
  }
}

/* 1. 원자료 탐색 */
let exploreSeq=0;
async function explore(){
  const seq=++exploreSeq;
  try{
    const d=await call('explore',{sheet:$('sheet').value,row:$('row').value});
    if(seq!==exploreSeq)return;
    rowChoices=d.rows;filterRows(d.selected);cells=d.cells;
    $('unit').textContent=d.unit;
    $('explore-caption').textContent=$('sheet').value+' / 행: '+d.selected+' '+d.name;
    renderCells();
  }catch(e){$('status').textContent=e.message;}
}
function filterRows(selected){
  const q=$('row-search').value.trim();
  options($('row'),rowChoices.filter(r=>(r.code+' '+r.name).includes(q)));
  if([...$('row').options].some(o=>o.value===selected))$('row').value=selected;
}
function renderCells(){
  const q=$('col-search').value.trim();
  $('cells').replaceChildren(...cells.filter(c=>(c.code+' '+c.name).includes(q)).map(c=>{
    const tr=document.createElement('tr');
    for(const v of [c.code,c.name,c.value===null?'빈 셀':typeof c.value==='number'?fmt(c.value):c.value])tr.append(text('td',v));
    return tr;
  }));
}
$('sheet').onchange=()=>{$('row-search').value='';$('row').replaceChildren();explore();};
$('row').onchange=explore;
$('row-search').oninput=()=>{filterRows();if($('row').value)explore();else{$('cells').replaceChildren();$('explore-caption').textContent='일치하는 행이 없습니다.';}};
$('col-search').oninput=renderCells;

/* 2. 수요충격 시뮬레이터 & 생산·수입·부가가치 순위 막대그래프 */
$('sector-search').oninput=()=>{
  const q=$('sector-search').value.trim();
  options($('sector'),sectors.filter(s=>(s.code+' '+s.name).includes(q)));
};
function renderBasket(){
  $('basket').replaceChildren(...basket.map((s,i)=>{
    const li=text('li',s.code+' '+s.name+' / '+fmt(s.amount)+'백만원 ');
    const b=text('button','삭제');b.type='button';
    b.onclick=()=>{basket.splice(i,1);invalidate();renderBasket();};
    li.append(b);return li;
  }));
  $('sim-status').textContent=basket.length?basket.length+'개 입력 준비. 계산 버튼을 누르세요.':'시나리오를 추가하세요.';
}
$('scenario').onsubmit=e=>{
  e.preventDefault();
  const amount=Number($('amount').value),s=sectors.find(s=>s.code===$('sector').value);
  if(!s||!Number.isFinite(amount)||amount<=0){$('sim-status').textContent='산업과 양의 증가액을 확인하세요.';return;}
  basket.push({...s,amount});invalidate();renderBasket();
};
$('clear').onclick=()=>{basket=[];invalidate();renderBasket();};
$('run').onclick=async()=>{
  if(!basket.length){$('sim-status').textContent='시나리오를 먼저 추가하세요.';return;}
  const snapshot=basket.map(s=>({...s}));
  $('run').disabled=true;$('sim-status').textContent='계산 중…';
  try{
    const r=await call('simulate',snapshot);
    if(JSON.stringify(snapshot)!==JSON.stringify(basket)){$('sim-status').textContent='입력이 변경되었습니다. 다시 계산하세요.';return;}
    result=r;renderResult();
    $('sim-status').textContent='계산 완료. 아래 결과는 현재 시나리오에 대응합니다.';
  }catch(e){invalidate();$('sim-status').textContent='계산 실패: '+e.message;}
  finally{$('run').disabled=false;}
};

document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    barMetric=btn.dataset.metric;
    if(result) renderBars();
  };
});

function renderBars(){
  const labelMap={production:'생산유발액',imports:'수입유발액',valueAdded:'부가가치유발액'};
  const colorMap={production:'#168179',imports:'#c05621',valueAdded:'#2b6cb0'};
  $('bar-title').textContent=labelMap[barMetric]+' 상위 15개 산업';

  const sorted=[...result.rows].sort((a,b)=>b[barMetric]-a[barMetric]);
  const top15=sorted.slice(0,15);
  const max=Math.max(...top15.map(r=>r[barMetric]),1e-9);

  $('bars').replaceChildren(...top15.map((r,idx)=>{
    const wrap=document.createElement('div');
    wrap.className='bar';
    const head=text('div',(idx+1)+'위 · '+r.code+' '+r.name+' — '+fmt(r[barMetric])+'백만원');
    const t=document.createElement('div');t.className='track';
    const f=document.createElement('div');f.className='fill';
    f.style.width=Math.max(0,r[barMetric]/max*100)+'%';
    f.style.background=colorMap[barMetric];
    t.append(f);wrap.append(head,t);
    return wrap;
  }));
}

function renderResult(){
  $('results').hidden=false;
  $('cards').replaceChildren(...[
    ['수요 증가액',result.demand],
    ['생산유발액',result.production],
    ['수입유발액',result.imports],
    ['부가가치유발액',result.valueAdded]
  ].map(([title,v])=>{
    const d=text('div',title);d.className='card';
    d.append(text('strong',fmt(v)),text('span','백만원'));
    return d;
  }));
  renderBars();
  $('result-rows').replaceChildren(...result.rows.map(r=>{
    const tr=document.createElement('tr');
    [r.code,r.name,fmt(r.production),fmt(r.imports),fmt(r.valueAdded)].forEach(v=>tr.append(text('td',v)));
    return tr;
  }));
}

function csvCell(v){let s=String(v);if(/^[=+@-]/.test(s)&&typeof v!=='number')s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
$('download').onclick=()=>{
  if(!result)return;
  const rows=[['산업코드','산업명','생산유발액_백만원','수입유발액_백만원','부가가치유발액_백만원'],
    ...result.rows.map(r=>[r.code,r.name,r.production,r.imports,r.valueAdded])];
  const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='io-2023-results.csv';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};

/* 3. 산업연관표 거래 관계 히트맵 */
async function loadHeatmap(){
  if(!$('hm-sheet').value) return;
  const mode=$('hm-mode').value;
  const topN=Number($('hm-top-n').value);
  $('hm-detail').textContent='히트맵 데이터를 불러오는 중…';
  try{
    hmData=await call('heatmap',{
      sheet:$('hm-sheet').value,
      mode,
      topN,
      customCodes:hmCustomList
    });
    renderHeatmap();
    $('hm-detail').textContent='셀을 클릭하면 해당 두 산업 간의 정확한 거래 금액(백만원)과 투입 비중을 볼 수 있습니다.';
  }catch(e){
    $('hm-detail').textContent='히트맵 오류: '+e.message;
  }
}

function getHeatColor(val, maxVal, scale){
  if(!val || val<=0 || maxVal<=0) return '#f8fafc';
  let ratio = scale==='log'
    ? Math.log1p(val) / Math.log1p(maxVal)
    : val / maxVal;
  ratio = Math.max(0, Math.min(1, ratio));
  // 옅은 민트/하늘색에서 진한 청록/남색으로 변화
  const h = 192;
  const s = Math.round(35 + ratio * 55);
  const l = Math.round(96 - ratio * 66);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function renderHeatmap(){
  if(!hmData || !hmData.sectors.length){
    $('hm-grid').replaceChildren(text('p','표시할 산업을 1개 이상 선택하세요.'));
    return;
  }
  const scale=$('hm-scale').value;
  const list=hmData.sectors;
  const mat=hmData.matrix;
  const maxVal=hmData.maxVal;
  $('hm-max-label').textContent='거래 활발 ('+fmt(maxVal)+'백만원)';

  const table=document.createElement('table');
  table.className='hm-table';

  const thead=document.createElement('thead');
  const headRow=document.createElement('tr');
  const corner=text('th','공급(행) \\ 수요(열)');
  corner.className='hm-corner';
  headRow.append(corner);
  list.forEach(col=>{
    const th=document.createElement('th');
    th.title=col.code+' '+col.name;
    th.textContent=col.name.length>7 ? col.name.slice(0,7)+'…' : col.name;
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead);

  const tbody=document.createElement('tbody');
  list.forEach((rowSec,i)=>{
    const tr=document.createElement('tr');
    const rowHeader=document.createElement('th');
    rowHeader.className='hm-row-head';
    rowHeader.title=rowSec.code+' '+rowSec.name;
    rowHeader.textContent=rowSec.code+' '+(rowSec.name.length>10 ? rowSec.name.slice(0,10)+'…' : rowSec.name);
    tr.append(rowHeader);

    list.forEach((colSec,j)=>{
      const val=mat[i][j];
      const td=document.createElement('td');
      td.className='hm-cell';
      td.style.backgroundColor=getHeatColor(val,maxVal,scale);
      td.title=`${rowSec.name} → ${colSec.name}: ${fmt(val)}백만원`;
      td.onclick=()=>{
        document.querySelectorAll('.hm-cell.selected').forEach(el=>el.classList.remove('selected'));
        td.classList.add('selected');
        const share = colSec.colTotal > 0 ? (val / colSec.colTotal * 100) : 0;
        $('hm-detail').innerHTML =
          `<strong>[${rowSec.code} ${rowSec.name}]</strong> → <strong>[${colSec.code} ${colSec.name}]</strong><br>` +
          `거래 금액: <strong>${fmt(val)}백만원</strong> (수요 산업 전체 중간투입 대비 약 ${share.toFixed(2)}%)`;
      };
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(tbody);
  $('hm-grid').replaceChildren(table);
}

function renderHmTags(){
  $('hm-selected-tags').replaceChildren(...hmCustomList.map(code=>{
    const sec=sectors.find(s=>s.code===code);
    const chip=document.createElement('span');
    chip.className='chip';
    chip.textContent=(sec ? sec.code+' '+sec.name : code)+' ';
    const x=text('button','×');
    x.type='button';
    x.onclick=()=>{
      hmCustomList=hmCustomList.filter(c=>c!==code);
      renderHmTags();
      if($('hm-mode').value==='custom') loadHeatmap();
    };
    chip.append(x);
    return chip;
  }));
}

$('hm-sheet').onchange=loadHeatmap;
$('hm-top-n').onchange=loadHeatmap;
$('hm-scale').onchange=renderHeatmap;
$('hm-mode').onchange=()=>{
  const isCustom=$('hm-mode').value==='custom';
  $('hm-top-wrap').hidden=isCustom;
  $('hm-custom-box').hidden=!isCustom;
  loadHeatmap();
};
$('hm-search').oninput=()=>{
  const q=$('hm-search').value.trim();
  options($('hm-sector-select'),sectors.filter(s=>(s.code+' '+s.name).includes(q)));
};
$('hm-add-sector').onclick=()=>{
  const code=$('hm-sector-select').value;
  if(!code || hmCustomList.includes(code)) return;
  if(hmCustomList.length>=20){alert('최대 20개 산업까지 비교할 수 있습니다.');return;}
  hmCustomList.push(code);
  renderHmTags();
  loadHeatmap();
};
$('hm-reset-sector').onclick=()=>{
  hmCustomList=[];
  renderHmTags();
  loadHeatmap();
};

/* 4. 전후방 연쇄효과 분석 */
function renderLinkages(){
  if(!linkages.length) return;
  const maxBL=linkages.reduce((a,b)=>a.backward>b.backward?a:b);
  const maxFL=linkages.reduce((a,b)=>a.forward>b.forward?a:b);
  const bothHigh=linkages.filter(x=>x.backward>=1 && x.forward>=1).length;

  $('linkage-cards').replaceChildren(...[
    ['최고 영향력계수 (후방)', maxBL.backward.toFixed(3), maxBL.name],
    ['최고 감응도계수 (전방)', maxFL.forward.toFixed(3), maxFL.name],
    ['핵심 선도형 부문 수', bothHigh+'개', '영향력 ≥ 1 & 감응도 ≥ 1']
  ].map(([title,big,sub])=>{
    const d=text('div',title);d.className='card';
    d.append(text('strong',big),text('span',sub));
    return d;
  }));

  renderLinkageScatter();
  renderLinkageTable();
}

function renderLinkageScatter(){
  const svg=$('linkage-svg');
  const W=540, H=420, padL=52, padR=24, padT=24, padB=44;
  const plotW=W-padL-padR, plotH=H-padT-padB;
  const maxX=Math.max(2.2, ...linkages.map(d=>d.backward))*1.05;
  const maxY=Math.max(2.2, ...linkages.map(d=>d.forward))*1.05;

  const sx=v=>padL + (v/maxX)*plotW;
  const sy=v=>padT + plotH - (v/maxY)*plotH;
  const x1=sx(1.0), y1=sy(1.0);

  const ns='http://www.w3.org/2000/svg';
  const el=(tag,attrs={})=>{
    const node=document.createElementNS(ns,tag);
    for(const [k,v] of Object.entries(attrs)) node.setAttribute(k,v);
    return node;
  };

  svg.replaceChildren();
  // 배경 사분면 영역 표시
  svg.append(
    el('rect',{x:x1,y:padT,width:W-padR-x1,height:y1-padT,fill:'#e6fffa',opacity:'0.75'}),
    el('rect',{x:padL,y:padT,width:x1-padL,height:y1-padT,fill:'#ebf8ff',opacity:'0.6'}),
    el('rect',{x:x1,y:y1,width:W-padR-x1,height:padT+plotH-y1,fill:'#fffaf0',opacity:'0.7'}),
    el('rect',{x:padL,y:y1,width:x1-padL,height:padT+plotH-y1,fill:'#f8fafc'})
  );

  // 테두리 및 기준선(1.0)
  svg.append(
    el('rect',{x:padL,y:padT,width:plotW,height:plotH,fill:'none',stroke:'#cbd5e1'}),
    el('line',{x1:x1,y1:padT,x2:x1,y2:padT+plotH,stroke:'#c05621','stroke-dasharray':'5,4','stroke-width':'1.5'}),
    el('line',{x1:padL,y1:y1,x2:padL+plotW,y2:y1,stroke:'#c05621','stroke-dasharray':'5,4','stroke-width':'1.5'})
  );

  // 사분면 라벨
  const lbl=(txt,x,y,anchor='start')=>{
    const t=el('text',{x,y,fill:'#475569','font-size':'11','text-anchor':anchor});
    t.textContent=txt;return t;
  };
  svg.append(
    lbl('핵심 선도형 (후방≥1, 전방≥1)', W-padR-6, padT+15, 'end'),
    lbl('기초 소재형 (전방≥1)', padL+6, padT+15, 'start'),
    lbl('최종재 견인형 (후방≥1)', W-padR-6, padT+plotH-8, 'end'),
    lbl('독립·특화형', padL+6, padT+plotH-8, 'start'),
    lbl('영향력계수 (후방연쇄효과) →', padL+plotW/2, H-10, 'middle')
  );
  const yTitle=lbl('감응도계수 (전방연쇄효과) →', 16, padT+plotH/2, 'middle');
  yTitle.setAttribute('transform',`rotate(-90, 16, ${padT+plotH/2})`);
  svg.append(yTitle);

  // 데이터 점 렌더링
  linkages.forEach(d=>{
    const color = (d.backward>=1 && d.forward>=1) ? '#0d9488'
                : (d.backward>=1) ? '#d97706'
                : (d.forward>=1) ? '#2563eb' : '#64748b';
    const c=el('circle',{
      cx:sx(d.backward).toFixed(1),
      cy:sy(d.forward).toFixed(1),
      r:'3.6',
      fill:color,
      opacity:'0.78',
      style:'cursor:pointer'
    });
    const showInfo=()=>{
      $('scatter-info').innerHTML=
        `<strong>[${d.code} ${d.name}]</strong> · ${d.group}<br>`+
        `영향력계수(후방): <strong>${d.backward.toFixed(4)}</strong> | 감응도계수(전방): <strong>${d.forward.toFixed(4)}</strong>`;
    };
    c.onmouseenter=showInfo;
    c.onclick=showInfo;
    svg.append(c);
  });
}

function renderLinkageTable(){
  const q=$('linkage-search').value.trim();
  const sortBy=$('linkage-sort').value;
  let filtered=linkages.filter(d=>(d.code+' '+d.name+' '+d.group).includes(q));
  if(sortBy==='backward') filtered.sort((a,b)=>b.backward-a.backward);
  else if(sortBy==='forward') filtered.sort((a,b)=>b.forward-a.forward);
  else filtered.sort((a,b)=>a.code.localeCompare(b.code));

  $('linkage-rows').replaceChildren(...filtered.map(d=>{
    const tr=document.createElement('tr');
    [d.code, d.name, d.backward.toFixed(4), d.forward.toFixed(4), d.group].forEach(v=>tr.append(text('td',v)));
    return tr;
  }));
}
$('linkage-search').oninput=renderLinkageTable;
$('linkage-sort').onchange=renderLinkageTable;

/* 초기 파일 로딩 */
async function loadDefaultWorkbook(){
  try {
    $('status').textContent='기본 Excel 내려받는 중…';
    const response=await fetch('./data/io-2023.xlsx');
    if(!response.ok)throw Error('기본 Excel 다운로드 실패 (HTTP '+response.status+')');
    await load(await response.arrayBuffer());
  }catch(error){
    $('status').textContent='준비 실패: '+error.message+' — 연결 상태를 확인하고 새로고침하세요.';
  }
}
$('load-basic').onclick=async()=>{
  const button=$('load-basic');
  button.disabled=true;
  button.textContent='불러오는 중…';
  try {
    await loadDefaultWorkbook();
    const ready=!$('sheet').disabled;
    button.textContent=ready?'기본부문 불러오기 완료':'기본부문 다시 불러오기';
    button.disabled=ready;
  }finally{
    if($('sheet').disabled){button.disabled=false;button.textContent='기본부문 다시 불러오기';}
  }
};
