// ==UserScript==
// @name         Trợ giúp tải tài liệu muasamcong (Full: Làm rõ HSDT & Kiến nghị)
// @namespace    local.tai-lieu-muasamcong
// @version      1.7.2
// @description  Thay VNeGP Client Agent tải tài liệu công khai, làm rõ HSDT, tải đơn kiến nghị & trả lời kiến nghị (Fix 500 & File is not shared) + hiện mã lỗi trên toast
// @match        https://muasamcong.mof.gov.vn/*
// @match        https://*.muasamcong.mof.gov.vn/*
// @match        https://muasamcong.mpi.gov.vn/*
// @match        https://*.muasamcong.mpi.gov.vn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__taiLieuMuasamcong) return;
  window.__taiLieuMuasamcong = { version: '1.7.2' };

  var AGENT_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:1234)?\/api\//i;
  var MAIN_ORIGIN = 'https://muasamcong.mof.gov.vn';
  var KN_API = '/o/egp-portal-contractor-selection-v2/services/lcnt_tbmt_kn?token=0';

  function isAgentUrl(u) { return AGENT_RE.test(String(u || '')); }
  function log() { try { console.log.apply(console, ['[Trợ giúp tải tài liệu]'].concat([].slice.call(arguments))); } catch (e) {} }

  /* ---------------- Tự động bắt Auth Token từ luồng mạng và Storage ---------------- */
  var capturedToken = null;

  function getAuthToken() {
    if (capturedToken) return capturedToken;
    try {
      var storages = [sessionStorage, localStorage];
      for (var s = 0; s < storages.length; s++) {
        var store = storages[s];
        for (var i = 0; i < store.length; i++) {
          var k = store.key(i);
          if (/token/i.test(k)) {
            var val = store.getItem(k);
            if (val && val.length > 20) {
              try {
                var j = JSON.parse(val);
                if (j.access_token) return j.access_token;
                if (j.token) return j.token;
              } catch (e) {}
              return val.replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');
            }
          }
        }
      }
    } catch (e) {}
    return null;
  }

  /* ---------------- Thông báo Toast ---------------- */
  var toastEl = null, toastTimer = null;
  function toast(msg, kind) {
    try {
      if (!document.body) return;
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:380px;' +
          'padding:10px 14px;border-radius:8px;font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;' +
          'color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25);transition:opacity .3s;white-space:pre-line';
        document.body.appendChild(toastEl);
      }
      toastEl.style.background = kind === 'error' ? '#c0392b' : kind === 'ok' ? '#1e8449' : '#1f4e8c';
      toastEl.textContent = msg;
      toastEl.style.opacity = '1';
      clearTimeout(toastTimer);
      // Toast lỗi giữ 20 giây để kịp chụp màn hình trên điện thoại
      toastTimer = setTimeout(function () { if (toastEl) toastEl.style.opacity = '0'; }, kind === 'error' ? 20000 : 4000);
    } catch (e) {}
  }

  function originsToTry() {
    var list = [location.origin];
    if (location.origin !== MAIN_ORIGIN) list.push(MAIN_ORIGIN);
    return list;
  }

  function nameFromDisposition(cd) {
    if (!cd) return null;
    var m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
    var name = null;
    if (m) { try { name = decodeURIComponent(m[1].trim()); } catch (e) { name = m[1]; } }
    if (!name) { m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd); if (m) name = m[1].trim(); }
    if (!name) return null;
    return name.replace(/^\d{12,20}_/, '');
  }

  async function isErrorBlob(blob) {
    if (!blob || blob.size === 0) return true;
    if (blob.size < 500 && (blob.type.indexOf('text') >= 0 || blob.type.indexOf('json') >= 0 || blob.type === '')) {
      try {
        var txt = await blob.text();
        if (/file is not shared/i.test(txt) || /errorCode/i.test(txt) || /"status":\s*(4|5)/.test(txt)) return true;
      } catch (e) {}
    }
    return false;
  }

  /* ---------------- Ghi nhận mã trạng thái từng lần thử (hiện trong toast lỗi) ---------------- */
  var dbg = [];
  async function tryFetch(url, headers) {
    var tag = url.replace(/^https?:\/\/[^/]+/, '').slice(0, 45);
    try {
      var r = await origFetch(url, { credentials: 'include', headers: headers });
      var first = r.status;
      // Token cũ/hết hạn -> thử lại không gửi Authorization
      if ((r.status === 401 || r.status === 403) && headers.Authorization) {
        r = await origFetch(url, { credentials: 'include' });
      }
      dbg.push((first !== r.status ? first + '→' : '') + r.status + ' ' + tag);
      return r;
    } catch (e) {
      dbg.push('ERR ' + tag);
      throw e;
    }
  }

  /* ---------------- Tải tệp (Hỗ trợ đa cơ chế: edocproxy nội bộ & public) ---------------- */
  async function fetchFile(fileId, explicitToken, fallbackName, explicitUrl) {
    dbg.length = 0;
    var token = explicitToken || getAuthToken();
    var headers = {};
    if (token) headers['Authorization'] = (token.startsWith('Bearer ') ? '' : 'Bearer ') + token;
    var origins = originsToTry();

    // 1. Nếu có URL trực tiếp
    if (explicitUrl) {
      try {
        var r0 = await tryFetch(explicitUrl, headers);
        if (r0.ok) {
          var b0 = await r0.blob();
          if (!(await isErrorBlob(b0))) {
            return { blob: b0, name: fallbackName || nameFromDisposition(r0.headers.get('content-disposition')) };
          }
          dbg.push('  ↳ nội dung lỗi');
        }
      } catch (e) {}
    }

    // 2. Tải qua cổng trực tiếp của edocproxy (Xử lý dứt điểm "File is not shared")
    var directPaths = [
      '/api/edocproxy/file/download/',
      '/api/edocproxy/file/',
      '/api/edocproxy/file/view/',
      '/api/unau/edocproxy/file/download/',
      '/api/unau/edocproxy/file/',
      '/o/egp-portal-contractor-selection-v2/services/file/download?fileId=',
      '/o/egp-portal-home/services/file/download?fileId='
    ];

    for (var p = 0; p < directPaths.length; p++) {
      var dpath = directPaths[p];
      for (var oi = 0; oi < origins.length; oi++) {
        try {
          var targetUrl = dpath.indexOf('?') >= 0 ? origins[oi] + dpath + encodeURIComponent(fileId) : origins[oi] + dpath + fileId;
          var rDir = await tryFetch(targetUrl, headers);
          if (rDir.ok) {
            var bDir = await rDir.blob();
            if (!(await isErrorBlob(bDir))) {
              var n = fallbackName || nameFromDisposition(rDir.headers.get('content-disposition'));
              return { blob: bDir, name: n || (fileId + '.pdf') };
            }
            dbg.push('  ↳ nội dung lỗi');
          }
        } catch (e) {}
      }
    }

    // 3. Dự phòng qua get-url cho file công khai
    var getUrlPaths = [
      '/o/egp-portal-contractor-selection-v2/services/file/get-url',
      '/o/egp-portal-home/services/file/get-url',
      '/o/egp-portal-home/services/public/file/get-url'
    ];
    for (var g = 0; g < getUrlPaths.length; g++) {
      for (var k = 0; k < origins.length; k++) {
        try {
          var rg = await origFetch(origins[k] + getUrlPaths[g], {
            method: 'POST',
            credentials: 'include',
            headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' }, headers),
            body: JSON.stringify({ fileId: fileId, responseUrl: true })
          });
          dbg.push(rg.status + ' POST ' + getUrlPaths[g].replace(/^.*services\//, '').slice(0, 30));
          if (rg.ok) {
            var jg = await rg.json();
            var shareLink = jg && (jg.publicKey || jg.url || (jg.data && (jg.data.publicKey || jg.data.url)));
            if (shareLink) {
              dbg.push('link=' + String(shareLink).replace(/^https?:\/\//, '').slice(0, 38));
              // Link công khai: thử lần lượt (kèm token) -> (không token) -> (không token, không cookie)
              var shareModes = [
                { label: 'token', opt: { credentials: 'include', headers: headers } },
                { label: 'noauth', opt: { credentials: 'include' } },
                { label: 'omit', opt: { credentials: 'omit' } }
              ];
              for (var sm = 0; sm < shareModes.length; sm++) {
                if (sm === 0 && !headers.Authorization) continue;
                var rShare = await origFetch(shareLink, shareModes[sm].opt);
                dbg.push(rShare.status + ' shareLink/' + shareModes[sm].label);
                if (rShare.ok) {
                  var bShare = await rShare.blob();
                  if (!(await isErrorBlob(bShare))) {
                    return { blob: bShare, name: fallbackName || nameFromDisposition(rShare.headers.get('content-disposition')) };
                  }
                  dbg.push('  ↳ nội dung lỗi');
                }
              }
            }
          }
        } catch (e) { dbg.push('ERR get-url'); }
      }
    }

    throw new Error('Không lấy được tệp từ máy chủ.\n' + (token ? '(có token)' : '(KHÔNG có token)') + '\n' + dbg.slice(-10).join('\n'));
  }

  /* ---------------- Tạo file ZIP ---------------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  async function makeZip(entries) {
    var enc = new TextEncoder();
    var d = new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var parts = [], central = [], offset = 0, used = {};
    for (var i = 0; i < entries.length; i++) {
      var name = (entries[i].name || ('file_' + (i + 1))).replace(/[\\/:*?"<>|]/g, '_');
      var base = name, k = 1;
      while (used[name.toLowerCase()]) { var dot = base.lastIndexOf('.'); name = dot > 0 ? base.slice(0, dot) + ' (' + (++k) + ')' + base.slice(dot) : base + ' (' + (++k) + ')'; }
      used[name.toLowerCase()] = 1;
      var nameBytes = enc.encode(name);
      var data = new Uint8Array(await entries[i].blob.arrayBuffer());
      var crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, nameBytes, data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nameBytes.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    var cdSize = central.reduce(function (s, p) { return s + (p.byteLength || p.length); }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end.buffer]), { type: 'application/zip' });
  }

  /* ---------------- Xử lý chuyên sâu cho phân hệ KIẾN NGHỊ ---------------- */
  var knCache = {}, knMount = null, knSyncTimer = null, knUi = null;
  function detectNotifyNo() {
    var m = null;
    try { m = /IB\d{8,}/i.exec(decodeURIComponent(location.href)); } catch (e) {}
    if (!m) { try { m = /IB\d{8,}/i.exec(document.body.innerText); } catch (e) {} }
    return m ? m[0].toUpperCase() : '';
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDate(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; }
  function parseList(s) { try { var v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } }

  async function fetchPetitionFiles(notifyNo) {
    var data = null, lastErr = null, origins = originsToTry();
    var token = getAuthToken();
    var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' };
    if (token) headers['Authorization'] = (token.startsWith('Bearer ') ? '' : 'Bearer ') + token;

    for (var i = 0; i < origins.length && !data; i++) {
      try {
        var r = await origFetch(origins[i] + KN_API, {
          method: 'POST', credentials: 'include',
          headers: headers,
          body: JSON.stringify({ notifyNo: notifyNo, processApply: 'LDT' })
        });
        if (!r.ok) { lastErr = new Error('Máy chủ trả mã ' + r.status); continue; }
        data = await r.json();
      } catch (e) { lastErr = e; }
    }
    if (!data) throw lastErr || new Error('Không lấy được danh sách kiến nghị');
    var out = [], idx = 0;
    (data.biduPetitionContractorVersionDTOList || []).forEach(function (ver) {
      (ver.biduPetitionContractorDTOList || []).forEach(function (p) {
        idx++;
        var who = p.contractorName || '';
        var g = { idx: idx, who: who, reqName: p.reqName || '', dates: [], snips: [] };
        var list = parseList(p.content);
        list.forEach(function (v) {
          var d = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.reqDate || ''); if (d) g.dates.push(d[3] + '/' + d[2] + '/' + d[1]);
          var sn = normText(v.reqContent).slice(0, 40); if (sn) g.snips.push(sn);
          if (v.reqFileId) {
            out.push({ idx: idx, who: who, g: g, type: 'KN', id: v.reqFileId, name: v.reqFileName, date: fmtDate(v.reqDate) });
            knownFiles[v.reqFileId] = { id: v.reqFileId, name: v.reqFileName || 'Don_kien_nghi.pdf' };
          }
        });
      });
    });
    return out;
  }

  function knFileName(f, fallback, withIdx) {
    return (withIdx ? '[' + pad2(f.idx) + ']' : '') + '[' + f.type + '] ' + (f.name || fallback || f.id);
  }

  function fileButton(f, compact) {
    var label = '⬇ [' + f.type + '] ' + (f.date ? f.date + ' · ' : '') + (f.name || f.id);
    var b = mk('button', BTN + (compact ? ';margin:4px 0;padding:6px 8px;font-size:12px;background:#fff' : ''), label);
    b.onclick = async function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      b.disabled = true; b.textContent = 'Đang tải…';
      try {
        var r = await fetchFile(f.id, null, f.name);
        saveBlob(r.blob, knFileName(f, r.name));
        b.textContent = '✓ ' + label.slice(2);
      } catch (e) {
        b.textContent = '✗ ' + e.message + ' – bấm để thử lại';
      }
      b.disabled = false;
    };
    return b;
  }

  function zipButton(files, no) {
    var all = mk('button', BTN + ';background:#1f4e8c;color:#fff;font-weight:600;cursor:pointer', '⬇ Tải tất cả kiến nghị (ZIP, ' + files.length + ' tệp)');
    all.onclick = async function () {
      all.disabled = true; var entries = [], failed = [];
      for (var i = 0; i < files.length; i++) {
        all.textContent = 'Đang tải ' + (i + 1) + '/' + files.length + '…';
        try {
          var r = await fetchFile(files[i].id, null, files[i].name);
          entries.push({ blob: r.blob, name: knFileName(files[i], r.name, true) });
        } catch (e) { failed.push(knFileName(files[i], null, true) + ' (' + e.message + ')'); }
      }
      if (entries.length) saveBlob(await makeZip(entries), 'KienNghi_' + no + '.zip');
      all.disabled = false;
      all.textContent = entries.length ? '✓ Đã tải ' + entries.length + '/' + files.length + (failed.length ? ' – lỗi: ' + failed.join('; ') : '') : '✗ Lỗi: ' + failed.join('; ');
    };
    return all;
  }

  function matchRows(tbl, groups) {
    var rows = [].slice.call(tbl.querySelectorAll('tr')).filter(function (r) { return r.cells && r.cells.length && !r.querySelector('th'); });
    var used = {}, res = {};
    groups.forEach(function (g) {
      var best = -1, bi = -1, gn = normText(g.reqName);
      rows.forEach(function (r, i) {
        if (used[i]) return;
        var t = normText(r.textContent), sc = 0, k;
        if (gn && t.indexOf(gn) >= 0) sc += 2;
        for (k = 0; k < g.snips.length; k++) if (t.indexOf(g.snips[k]) >= 0) { sc += 2; break; }
        for (k = 0; k < g.dates.length; k++) if (t.indexOf(g.dates[k]) >= 0) { sc += 1; break; }
        if (parseInt(r.cells[0].textContent, 10) === g.idx) sc += 1;
        if (sc > best) { best = sc; bi = i; }
      });
      if (bi >= 0 && best >= 2) { used[bi] = 1; res[g.idx] = rows[bi]; }
    });
    return res;
  }

  function findKnHeader() {
    var re = /^\s*nội dung kiến nghị\s*$/i, i, c = document.querySelectorAll('th');
    for (i = 0; i < c.length; i++) if (re.test(c[i].textContent)) return c[i];
    c = document.querySelectorAll('td,div,span,p');
    for (i = 0; i < c.length; i++) if (!c[i].children.length && re.test(c[i].textContent)) return c[i];
    return null;
  }

  function removeKn() {
    if (knMount) { knMount.remove(); knMount = null; knUi = null; }
    [].slice.call(document.querySelectorAll('[data-tlm-row]')).forEach(function (n) { n.remove(); });
  }

  function buildKnBlock() {
    var wrap = mk('div', 'margin:12px 0;padding:10px;border:2px solid #1f4e8c;border-radius:10px;background:#f5f9ff;color:#1d2733;font:14px/1.4 -apple-system,Segoe UI,Arial,sans-serif');
    wrap.setAttribute('data-tlm', 'kn');
    var st = mk('div', 'color:#67727e'), top = mk('div'), rest = mk('div');
    wrap.appendChild(st); wrap.appendChild(top); wrap.appendChild(rest);
    knUi = { wrap: wrap, st: st, top: top, rest: rest, no: '', files: null, restKey: '' };
    return wrap;
  }

  function applyKn(tbl) {
    var u = knUi, files = u && u.files;
    if (!files) return;
    if (!files.length) { u.st.textContent = 'Không có tệp đính kèm kiến nghị nào (' + u.no + ').'; return; }
    var seen = {}, groups = [];
    files.forEach(function (f) { if (!seen[f.idx]) { seen[f.idx] = 1; groups.push(f.g); } });
    var map = tbl ? matchRows(tbl, groups) : {};
    var unmatched = [];
    groups.forEach(function (g) {
      var row = map[g.idx], gf = files.filter(function (f) { return f.idx === g.idx; });
      if (!row) { unmatched.push(g.idx); return; }
      if (row.querySelector('[data-tlm-row="' + g.idx + '"]')) return;
      var holder = mk('div', 'margin-top:8px;padding-top:6px;border-top:1px dashed #9aa5b1');
      holder.setAttribute('data-tlm-row', g.idx);
      gf.forEach(function (f) { holder.appendChild(fileButton(f, true)); });
      row.cells[row.cells.length - 1].appendChild(holder);
    });

    var key = unmatched.join(',');
    if (key !== u.restKey) {
      u.restKey = key; u.rest.textContent = '';
      if (unmatched.length) {
        u.rest.appendChild(mk('div', 'margin:6px 0 0;color:#67727e', 'Chưa ghép được vào dòng nào:'));
        unmatched.forEach(function (idx) {
          var gf = files.filter(function (f) { return f.idx === idx; });
          u.rest.appendChild(mk('div', 'font-weight:700;margin:6px 0 2px;color:#1f4e8c', '#' + pad2(idx) + '  ' + gf[0].who));
          gf.forEach(function (f) { u.rest.appendChild(fileButton(f, false)); });
        });
      }
    }
  }

  function startKnLoad(no, tbl) {
    var u = knUi; u.no = no; u.files = null;
    u.st.textContent = 'Đang lấy tệp kiến nghị ' + no + '…';
    var p = knCache[no] || (knCache[no] = fetchPetitionFiles(no));
    p.then(function (files) {
      if (knUi !== u) return;
      u.files = files;
      u.st.textContent = files.length ? '' : 'Không có tệp đính kèm kiến nghị nào (' + no + ').';
      u.top.textContent = '';
      if (files.length > 1) u.top.appendChild(zipButton(files, no));
      applyKn(knCurrentTable());
      renderPanel();
    }, function (e) {
      delete knCache[no];
      if (knUi === u) u.st.textContent = 'Lỗi tải kiến nghị: ' + (e && e.message ? e.message : e);
    });
  }

  function knCurrentTable() { var h = findKnHeader(); return h ? h.closest('table') : null; }

  function syncKn() {
    var h = findKnHeader();
    if (!h) { removeKn(); return; }
    var tbl = h.closest('table');
    if (!knMount || !knMount.isConnected) {
      removeKn();
      knMount = buildKnBlock();
      if (tbl && tbl.parentNode) tbl.parentNode.insertBefore(knMount, tbl.nextSibling);
      else {
        knMount.style.cssText += ';position:fixed;left:12px;right:12px;bottom:70px;z-index:2147483645;max-height:50vh;overflow:auto;box-shadow:0 4px 18px rgba(0,0,0,.3)';
        document.body.appendChild(knMount);
      }
      var no = detectNotifyNo();
      if (no) startKnLoad(no, tbl);
      else {
        knUi.st.textContent = 'Không tự nhận ra mã thông báo – nhập tay:';
        var row = mk('div', 'display:flex;gap:6px;margin-top:6px');
        var inp = mk('input', 'flex:1;min-width:0;padding:8px;font-size:16px;border:1px solid #9aa5b1;border-radius:6px');
        inp.placeholder = 'IBxxxxxxxxxx';
        var go = mk('button', 'padding:8px 12px;border:0;border-radius:6px;background:#1f4e8c;color:#fff;font:inherit;font-weight:600;cursor:pointer', 'Tìm');
        var run = function () { var v = inp.value.trim().toUpperCase(); if (v) startKnLoad(v, knCurrentTable()); };
        go.onclick = run; inp.onkeydown = function (e) { if (e.key === 'Enter') run(); };
        row.appendChild(inp); row.appendChild(go); knUi.wrap.insertBefore(row, knUi.st.nextSibling);
      }
      return;
    }
    if (knUi && knUi.files) applyKn(tbl);
  }

  function scheduleSync() {
    if (knSyncTimer) return;
    knSyncTimer = setTimeout(function () {
      knSyncTimer = null;
      try { syncKn(); } catch (e) { log('Lỗi khối kiến nghị', e); }
      try { annotateFiles(); } catch (e) { log('Lỗi gắn nút tải', e); }
    }, 400);
  }

  /* ---------------- Panel nổi & Quét tệp trên trang ---------------- */
  var items = [], blobNames = new WeakMap(), urlNames = {}, panelEl = null, listEl = null, headEl = null, boxEl = null, foundEl = null;
  var IS_TOP = true; try { IS_TOP = window.top === window; } catch (e) {}
  function getAuto() { try { return localStorage.getItem('tlm_auto') === '1'; } catch (e) { return false; } }
  function setAuto(v) { try { localStorage.setItem('tlm_auto', v ? '1' : '0'); } catch (e) {} }

  function mk(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e; }
  var BTN = 'display:block;width:100%;text-align:left;margin:3px 0;padding:9px 10px;border:1px solid #1f4e8c;background:#eef4fc;color:#1f4e8c;border-radius:6px;font:inherit;word-break:break-all';

  function normText(t) { return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function normFileName(n) { return normText(String(n || '').replace(/^\d{12,20}_/, '')); }

  var knownFiles = {};
  var harvestDirty = false;
  var FILE_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|png|jpe?g|txt|xml|p7s)$/i;

  function harvestObj(o, depth) {
    if (depth > 9 || o === null || o === undefined) return;
    if (typeof o === 'string') {
      var c = o.charAt(0);
      if ((c === '[' || c === '{') && o.length < 300000) { try { harvestObj(JSON.parse(o), depth + 1); } catch (e) {} }
      return;
    }
    if (typeof o !== 'object') return;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) harvestObj(o[i], depth + 1); return; }

    var keys = Object.keys(o), lower = {};
    keys.forEach(function (k) { lower[k.toLowerCase()] = k; });

    keys.forEach(function (k) {
      var m = /^(.*)(fileid|fileguid|docid|attachmentid|reqfileid|resfileid)$/i.exec(k), v = o[k];
      if (m && typeof v === 'string' && v.length > 0 && v.length < 120) {
        var prefix = m[1].toLowerCase();
        var nk = lower[prefix + 'filename'] || lower[prefix + 'name'] || lower['filename'] || lower['name'] || lower['originalname'] || lower['attachname'] || lower['title'];
        var nv = nk ? o[nk] : null;
        if (typeof nv === 'string' && nv && !knownFiles[v]) {
          knownFiles[v] = { id: v, name: String(nv).replace(/^\d{12,20}_/, '') };
          harvestDirty = true;
        }
      }
    });

    if (typeof o.id === 'string' && o.id.length >= 8 && o.id.length < 120 && !knownFiles[o.id]) {
      var candidateName = o.fileName || o.name || o.attachName || o.originalName || o.title;
      if (typeof candidateName === 'string' && FILE_EXT_RE.test(candidateName)) {
        knownFiles[o.id] = { id: o.id, name: String(candidateName).replace(/^\d{12,20}_/, '') };
        harvestDirty = true;
      }
    }

    keys.forEach(function (k) { harvestObj(o[k], depth + 1); });
  }

  function harvestBody(body) {
    try {
      var data = body;
      if (typeof body === 'string') {
        if (body.length > 3000000) return;
        var c = body.trim().charAt(0); if (c !== '{' && c !== '[') return;
        data = JSON.parse(body);
      }
      harvestDirty = false;
      harvestObj(data, 0);
      if (harvestDirty) { renderPanel(); scheduleSync(); }
    } catch (e) {}
  }

  function hookLoad(xhr) {
    try {
      xhr.addEventListener('load', function () {
        try {
          var t = xhr.responseType;
          if (t === '' || t === 'text') harvestBody(xhr.responseText);
          else if (t === 'json') harvestBody(xhr.response);
        } catch (e) {}
      });
    } catch (e) {}
  }

  function annotateFiles() {
    if (!document.body) return;
    var names = {}, any = false;
    Object.keys(knownFiles).forEach(function (id) {
      var k = normFileName(knownFiles[id].name);
      if (k) { names[k] = knownFiles[id]; any = true; }
    });
    if (!any) return;

    var els = document.body.querySelectorAll('a,span,div,p,td,li,label,b,strong,em,button,i,u'), hits = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i], t = el.textContent;
      if (!t || t.length > 250) continue;
      var f = names[normFileName(t)];
      if (!f) continue;
      if (el.closest('[data-tlm],[data-tlm-row],[data-tlm-dl]') || (panelEl && panelEl.contains(el))) continue;
      hits.push({ el: el, f: f });
    }

    hits.forEach(function (h) {
      if (hits.some(function (o) { return o !== h && h.el !== o.el && h.el.contains(o.el); })) return;
      var nx = h.el.nextElementSibling;
      if (nx && nx.hasAttribute('data-tlm-dl')) return;
      var b = mk('button', 'display:inline-block;margin-left:6px;padding:2px 8px;border:1px solid #1f4e8c;border-radius:6px;background:#eef4fc;color:#1f4e8c;font:600 13px/1.4 -apple-system,Segoe UI,Arial,sans-serif;cursor:pointer;vertical-align:middle', '⬇ Tải');
      b.type = 'button'; b.title = 'Tải về: ' + h.f.name; b.setAttribute('data-tlm-dl', h.f.id);
      b.onclick = async function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        b.disabled = true; b.textContent = '…';
        try {
          var r = await fetchFile(h.f.id, null, h.f.name);
          saveBlob(r.blob, h.f.name || r.name);
          b.textContent = '✓ Đã tải';
        } catch (e) {
          b.textContent = '✗ Lỗi';
          toast('Không tải được tài liệu:\n' + e.message, 'error');
        }
        b.disabled = false;
      };
      h.el.insertAdjacentElement('afterend', b);
    });
  }

  function closeBox() { if (boxEl) boxEl.style.display = 'none'; }
  function ensurePanel() {
    if (panelEl || !document.body || !IS_TOP) return;
    panelEl = mk('div', 'position:fixed;right:12px;bottom:70px;z-index:2147483646;font:13px/1.4 -apple-system,Segoe UI,Arial,sans-serif;max-width:min(380px,calc(100vw - 24px))');
    headEl = mk('button', 'display:block;margin-left:auto;background:#1f4e8c;color:#fff;border:0;border-radius:18px;padding:8px 14px;font:inherit;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer');
    boxEl = mk('div', 'display:none;margin-bottom:8px;background:#fff;color:#1d2733;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.3);padding:8px;max-height:60vh;overflow:auto');
    var top = mk('div', 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ddd;padding-bottom:6px;margin-bottom:6px');
    var lab = mk('label', 'flex:1;cursor:pointer');
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = getAuto();
    cb.onchange = function () { setAuto(cb.checked); };
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' Tải thẳng, không mở tab xem'));
    var x = mk('button', 'border:0;background:#eee;color:#1d2733;border-radius:50%;width:32px;height:32px;font-size:16px;line-height:1;cursor:pointer', '✕');
    x.onclick = closeBox;
    top.appendChild(lab); top.appendChild(x); boxEl.appendChild(top);

    boxEl.appendChild(mk('div', 'font-weight:700;margin:4px 0 2px', 'Tệp đã lấy'));
    listEl = mk('div'); boxEl.appendChild(listEl);
    boxEl.appendChild(mk('div', 'font-weight:700;margin:10px 0 2px;border-top:1px solid #ddd;padding-top:8px', 'Tệp phát hiện trên trang'));
    foundEl = mk('div'); boxEl.appendChild(foundEl);

    headEl.onclick = function () { boxEl.style.display = boxEl.style.display === 'none' ? 'block' : 'none'; };
    document.addEventListener('click', function (e) { if (e.isTrusted && boxEl.style.display !== 'none' && !panelEl.contains(e.target)) closeBox(); }, true);
    panelEl.appendChild(boxEl); panelEl.appendChild(headEl);
    document.body.appendChild(panelEl);
    renderPanel();
  }

  function renderPanel() {
    if (!panelEl) return;
    var ids = Object.keys(knownFiles), n = ids.length || items.length;
    headEl.textContent = '⬇ Tải tài liệu' + (n ? ' (' + n + ')' : '');
    foundEl.textContent = '';
    if (!ids.length) foundEl.appendChild(mk('div', 'color:#67727e', 'Chưa phát hiện tệp nào.'));
    ids.slice(-30).reverse().forEach(function (id) {
      var f = knownFiles[id], fb = mk('button', BTN, '⬇ ' + f.name);
      fb.onclick = async function () {
        fb.disabled = true;
        try { var r = await fetchFile(f.id, null, f.name); saveBlob(r.blob, f.name || r.name); }
        catch (e) { toast('Không tải được tài liệu:\n' + e.message, 'error'); }
        fb.disabled = false;
      };
      foundEl.appendChild(fb);
    });
    listEl.textContent = '';
    if (!items.length) listEl.appendChild(mk('div', 'color:#67727e', 'Chưa có.'));
    items.slice().reverse().forEach(function (it) {
      var b = mk('button', BTN, '⬇ ' + it.name);
      b.onclick = function () { saveBlob(it.blob, it.name); };
      listEl.appendChild(b);
    });
  }

  function register(blob, name) {
    name = name || 'download';
    blobNames.set(blob, name);
    items.push({ blob: blob, name: name });
    if (items.length > 15) items.shift();
    ensurePanel(); renderPanel();
  }

  function initUI() {
    if (!IS_TOP) return;
    ensurePanel();
    try { new MutationObserver(scheduleSync).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
    scheduleSync();
  }
  if (document.body) initUI(); else document.addEventListener('DOMContentLoaded', initUI);

  var origCreateURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var u = origCreateURL(obj);
    if (blobNames.has(obj)) urlNames[u] = { blob: obj, name: blobNames.get(obj) };
    return u;
  };

  /* ---------------- Xử lý yêu cầu gọi VNeGP Agent ---------------- */
  function parseIdMap(u) {
    var out = [];
    var mf = u.searchParams.get('mapFiles');
    if (mf) { try { var obj = JSON.parse(mf); Object.keys(obj).forEach(function (id) { out.push({ id: id, name: obj[id] }); }); } catch (e) {} }
    u.searchParams.forEach(function (v, k) { var m = /^mapFiles\[(.+)\]$/.exec(k); if (m) out.push({ id: m[1], name: v }); });
    ['fileIds', 'fileIds[]', 'fileId'].forEach(function (key) {
      u.searchParams.getAll(key).forEach(function (v) {
        String(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (id) { out.push({ id: id, name: null }); });
      });
    });
    return out;
  }

  async function handleAgentRequest(urlStr) {
    var u = new URL(urlStr);
    var path = u.pathname.replace(/\/+$/, '');
    var token = u.searchParams.get('token') || u.searchParams.get('accessToken') || getAuthToken();
    var directUrl = u.searchParams.get('url') || u.searchParams.get('downloadUrl') || u.searchParams.get('fileUrl');
    log('Chặn gọi Agent:', path, u.search);

    // 1. Giả lập /api/version/get (Triệt tiêu lỗi 500)
    if (/\/api\/version(\/get)?$/i.test(path) || /\/api\/(check|ping|status)$/i.test(path)) {
      var verData = JSON.stringify({ code: 200, status: 200, message: 'success', data: '2.0.0', version: '2.0.0' });
      return { blob: new Blob([verData], { type: 'application/json' }), name: null, isJson: true };
    }

    if (/\/api\/cert(ificate)?(\/.*)?$/i.test(path)) {
      var certData = JSON.stringify({ code: 200, data: [], message: 'success' });
      return { blob: new Blob([certData], { type: 'application/json' }), name: null, isJson: true };
    }

    // 2. Tải 1 file
    if (/\/api\/download\/file(\/browser(\/(public|private|contractor|shared))?)?$/i.test(path) || /\/api\/download\/file$/i.test(path)) {
      var fid = u.searchParams.get('fileId') || u.searchParams.get('id');
      var fname = u.searchParams.get('fileName') || u.searchParams.get('name');
      if (!fid && !directUrl) throw new Error('Thiếu thông tin file');
      toast('Đang tải tài liệu…');
      var f = await fetchFile(fid, token, fname, directUrl);
      toast('Đã tải xong' + (f.name ? ': ' + f.name : '') + '\nBấm nút "⬇ Tải tài liệu" để lưu', 'ok');
      register(f.blob, f.name);
      return { blob: f.blob, name: f.name };
    }

    // 3. Tải ZIP nhiều file
    if (/\/api\/download\/files(\/browser(\/(public|shared|private|contractor))?)?$/i.test(path) || /\/api\/download\/files$/i.test(path)) {
      var list = parseIdMap(u);
      if (!list.length) throw new Error('Không có file nào để tải');
      var zipName = u.searchParams.get('fileName') || 'TaiLieu.zip';
      var entries = [], failed = [];
      for (var i = 0; i < list.length; i++) {
        toast('Đang tải ' + (i + 1) + '/' + list.length + (list[i].name ? ': ' + list[i].name : '') + '…');
        try {
          var r = await fetchFile(list[i].id, token, list[i].name);
          entries.push({ blob: r.blob, name: list[i].name || r.name || (list[i].id + '.bin') });
        } catch (e) { failed.push((list[i].name || list[i].id) + ' (' + e.message + ')'); }
      }
      if (!entries.length) throw new Error('Không tải được file nào:\n' + failed.join('\n'));
      toast('Đang đóng gói ZIP…');
      var zip = await makeZip(entries);
      toast('Đã tải ' + entries.length + '/' + list.length + ' file vào ' + zipName +
        (failed.length ? '\nLỗi: ' + failed.join('; ') : ''), failed.length ? 'error' : 'ok');
      register(zip, zipName);
      return { blob: zip, name: zipName };
    }

    throw new Error('Chức năng Agent chưa được hỗ trợ: ' + path);
  }

  /* ---------------- Vá XMLHttpRequest & Fetch (Bắt Header Authorization) ---------------- */
  var origFetch = window.fetch.bind(window);
  var XHR = window.XMLHttpRequest;
  var pOpen = XHR.prototype.open, pSend = XHR.prototype.send, pSetHeader = XHR.prototype.setRequestHeader,
      pAbort = XHR.prototype.abort, pGetAll = XHR.prototype.getAllResponseHeaders, pGetOne = XHR.prototype.getResponseHeader;

  XHR.prototype.open = function (method, url) {
    if (isAgentUrl(url)) { this.__egp = { url: new URL(String(url), location.href).href, aborted: false }; return; }
    this.__egp = null; this.__tlmUrl = String(url);
    return pOpen.apply(this, arguments);
  };

  XHR.prototype.setRequestHeader = function (header, value) {
    try {
      if (/^authorization$/i.test(header) && value) {
        capturedToken = String(value).replace(/^Bearer\s+/i, '').trim();
      }
    } catch (e) {}
    if (this.__egp) return;
    return pSetHeader.apply(this, arguments);
  };

  XHR.prototype.abort = function () { if (this.__egp) { this.__egp.aborted = true; return; } return pAbort.apply(this, arguments); };
  XHR.prototype.getAllResponseHeaders = function () { if (this.__egp) return this.__egp.headers || ''; return pGetAll.apply(this, arguments); };
  XHR.prototype.getResponseHeader = function (h) {
    if (this.__egp) { var m = new RegExp('^' + h + ':\\s*(.*)$', 'im').exec(this.__egp.headers || ''); return m ? m[1] : null; }
    return pGetOne.apply(this, arguments);
  };

  function def(xhr, k, v) { try { Object.defineProperty(xhr, k, { configurable: true, get: function () { return v; } }); } catch (e) {} }
  function fire(xhr, type) { try { xhr.dispatchEvent(new ProgressEvent(type)); } catch (e) {} }

  XHR.prototype.send = function () {
    var xhr = this, st = this.__egp;
    if (!st) { hookLoad(this); return pSend.apply(this, arguments); }
    handleAgentRequest(st.url).then(function (res) {
      if (st.aborted) return;
      var rt = xhr.responseType;
      var finish = function (body) {
        st.headers = 'content-type: ' + (res.blob.type || 'application/octet-stream') + '\r\n' +
          (res.name ? "content-disposition: attachment; filename*=UTF-8''" + encodeURIComponent(res.name) + '\r\n' : '');
        def(xhr, 'readyState', 4); def(xhr, 'status', 200); def(xhr, 'statusText', 'OK');
        def(xhr, 'responseURL', st.url); def(xhr, 'response', body);
        if (typeof body === 'string') def(xhr, 'responseText', body);
        fire(xhr, 'readystatechange'); fire(xhr, 'load'); fire(xhr, 'loadend');
      };

      if (rt === 'blob') finish(res.blob);
      else if (rt === 'arraybuffer') res.blob.arrayBuffer().then(finish);
      else if (rt === 'json') {
        res.blob.text().then(function (txt) {
          try { finish(JSON.parse(txt)); } catch (e) { finish(txt); }
        });
      } else {
        res.blob.text().then(finish);
      }
    }).catch(function (err) {
      if (st.aborted) return;
      log('Lỗi:', err);
      toast('Không tải được tài liệu:\n' + (err && err.message ? err.message : err), 'error');
      st.headers = 'content-type: text/plain\r\n';
      def(xhr, 'readyState', 4); def(xhr, 'status', 500); def(xhr, 'statusText', 'Download helper error');
      def(xhr, 'responseURL', st.url); def(xhr, 'response', new Blob([String(err && err.message || err)]));
      fire(xhr, 'readystatechange'); fire(xhr, 'load'); fire(xhr, 'loadend');
    });
  };

  window.fetch = function (input, init) {
    try {
      if (init && init.headers) {
        var h = init.headers;
        if (typeof h.get === 'function') {
          var auth = h.get('Authorization') || h.get('authorization');
          if (auth) capturedToken = String(auth).replace(/^Bearer\s+/i, '').trim();
        } else if (typeof h === 'object') {
          var auth2 = h['Authorization'] || h['authorization'];
          if (auth2) capturedToken = String(auth2).replace(/^Bearer\s+/i, '').trim();
        }
      }
    } catch (e) {}

    var url = typeof input === 'string' ? input : (input && input.url);
    if (!isAgentUrl(url)) {
      var fp = origFetch(input, init);
      try { fp.then(function (r) { try { r.clone().text().then(harvestBody, function () {}); } catch (e) {} }, function () {}); } catch (e) {}
      return fp;
    }
    return handleAgentRequest(new URL(url, location.href).href).then(function (res) {
      var h = { 'content-type': res.blob.type || 'application/octet-stream' };
      if (res.name) h['content-disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(res.name);
      return new Response(res.blob, { status: 200, headers: h });
    }, function (err) {
      toast('Không tải được tài liệu:\n' + err.message, 'error');
      return new Response(String(err.message), { status: 500 });
    });
  };

  /* ---------------- Lưu Blob & window.open ---------------- */
  function saveBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || 'download';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  }

  var origOpenWin = window.open;
  window.open = function (url) {
    var known = urlNames[String(url)];
    if (known && getAuto()) {
      saveBlob(known.blob, known.name);
      toast('Đã lưu: ' + known.name, 'ok');
      return { close: function () {}, closed: true, focus: function () {} };
    }
    if (!isAgentUrl(url)) return origOpenWin.apply(window, arguments);
    handleAgentRequest(new URL(url, location.href).href).then(
      function (res) { saveBlob(res.blob, res.name); },
      function (err) { toast('Không tải được tài liệu:\n' + err.message, 'error'); }
    );
    return { close: function () {}, closed: true, focus: function () {} };
  };

  log('Đã sẵn sàng v1.7.2 – Hợp nhất hoàn chỉnh Làm rõ HSDT & Kiến nghị (có mã lỗi trên toast).');
})();
