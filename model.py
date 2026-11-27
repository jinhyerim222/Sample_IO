import json, io
import numpy as np
import openpyxl
book = None

def emit(x):
    return json.dumps(x, ensure_ascii=False, allow_nan=False)

def initialize(raw):
    global book, codes, names, L, M, V, sheets, valid
    wb = openpyxl.load_workbook(io.BytesIO(bytes(raw)), read_only=True, data_only=True)
    book = {s: list(wb[s].values) for s in wb.sheetnames}
    wb.close()
    sheets = list(book)
    base = book['국산투입계수(Ad)']
    codes = [str(c) for c in base[4][2:] if c is not None and str(c).isdigit() and int(str(c)) < 9000]
    if len(codes) != 380 or len(set(codes)) != len(codes):
        raise ValueError('이 버전은 첨부된 2023년 380부문 워크북 구조만 지원합니다.')
    nm = {str(r[0]): str(r[1]) for r in base[6:]}
    names = [nm[c] for c in codes]
    def matrix(s):
        rows = book[s]
        ri = {str(r[0]): i for i,r in enumerate(rows) if r}
        ci = {str(c): i for i,c in enumerate(rows[4])}
        a = np.array([[rows[ri[c]][ci[k]] for k in codes] for c in codes], dtype=float)
        if not np.isfinite(a).all(): raise ValueError(s + ': 비수치 또는 결측 데이터')
        return a
    L = matrix('생산유발계수'); M = matrix('수입유발계수'); V = matrix('부가가치유발계수')
    ad = matrix('국산투입계수(Ad)'); am = matrix('수입투입계수(Am)')
    rows=book['총투입계수(A)']; ci={str(c):i for i,c in enumerate(rows[4])}
    vr=next(r for r in rows if str(r[0])=='9690')
    v=np.array([vr[ci[c]] for c in codes],dtype=float)
    residuals = {'생산':float(np.max(np.abs((np.eye(len(codes))-ad)@L-np.eye(len(codes))))),
                 '수입':float(np.max(np.abs(am@L-M))),
                 '부가가치':float(np.max(np.abs(v[:,None]*L-V)))}
    valid = max(residuals.values()) < 1e-8
    if not valid: raise ValueError('계수 검증 실패: '+str(residuals))

    # 1) 산업별 생산·수입·부가가치 유발계수 (열합: 해당 산업 최종수요 1단위당 유발효과)
    prod_coef = L.sum(axis=0)
    imp_coef = M.sum(axis=0)
    va_coef = V.sum(axis=0)

    effects = [
        {
            'code': c,
            'name': name,
            'production': float(p),
            'imports': float(imp),
            'valueAdded': float(va)
        }
        for c, name, p, imp, va in zip(codes, names, prod_coef, imp_coef, va_coef)
    ]

    # 2) 전후방 연쇄효과 (영향력계수 & 감응도계수)
    n = len(codes)
    mean_L = float(L.sum()) / n
    bl = prod_coef / mean_L
    fl = L.sum(axis=1) / mean_L
    linkage_data = [
        {
            'code': c,
            'name': name,
            'backward': float(b_val),
            'forward': float(f_val)
        }
        for c, name, b_val, f_val in zip(codes, names, bl, fl)
    ]

    amount_sheets = [s for s in sheets if '거래표' in s]
    return emit({
        'sectors': [{'code': c, 'name': n} for c, n in zip(codes, names)],
        'sheets': sheets,
        'amountSheets': amount_sheets,
        'residuals': residuals,
        'effects': effects,
        'linkages': linkage_data
    })

def explore(sheet, rowcode):
    rows=book[sheet]
    choices=[{'code':str(r[0]),'name':str(r[1])} for r in rows[6:] if len(r)>1 and r[0] is not None and r[1] is not None]
    chosen=next((r for r in rows[6:] if str(r[0])==rowcode),None)
    if chosen is None: chosen=next(r for r in rows[6:] if r[0] is not None and r[1] is not None)
    cells=[]
    for i in range(2,len(rows[4])):
        if rows[4][i] is None: continue
        val=chosen[i] if i<len(chosen) else None
        if isinstance(val,(float,int)): val=float(val)
        elif val is not None: val=str(val)
        cells.append({'code':str(rows[4][i]),'name':str(rows[5][i] or ''),'value':val})
    return emit({'rows':choices,'selected':str(chosen[0]),'name':str(chosen[1]),
                 'unit':str(rows[3][0] or '係数').replace('係数','계수 / 비율: 행·열 명칭 확인'), 'cells':cells})

def heatmap(sheet, mode='top', top_n=15, custom_codes=None):
    rows = book[sheet]
    ri = {str(r[0]): i for i, r in enumerate(rows) if r and r[0] is not None}
    ci = {str(c): i for i, c in enumerate(rows[4]) if c is not None}
    full = np.zeros((len(codes), len(codes)), dtype=float)
    for idx_i, r_code in enumerate(codes):
        if r_code not in ri:
            continue
        row_vals = rows[ri[r_code]]
        for idx_j, c_code in enumerate(codes):
            if c_code in ci:
                v = row_vals[ci[c_code]]
                if isinstance(v, (int, float)) and np.isfinite(v):
                    full[idx_i, idx_j] = float(v)

    col_totals = full.sum(axis=0)
    if mode == 'custom' and custom_codes:
        selected_idx = [codes.index(c) for c in custom_codes if c in codes]
    else:
        n = max(5, min(30, int(top_n)))
        activity = full.sum(axis=0) + full.sum(axis=1)
        selected_idx = list(np.argsort(activity)[::-1][:n])

    sub = full[np.ix_(selected_idx, selected_idx)]
    sel_sectors = [{'code': codes[i], 'name': names[i], 'colTotal': float(col_totals[i])} for i in selected_idx]
    return emit({
        'sheet': sheet,
        'sectors': sel_sectors,
        'matrix': sub.tolist(),
        'maxVal': float(sub.max()) if sub.size else 0.0
    })
