/* 탭 전환 · 부가 UI (계산 로직은 app.js에 그대로 둡니다) */
(function () {
  'use strict';

  function init() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tabbar .tab'));
    if (!tabs.length) return;

    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });

    function activate(tab, opts) {
      opts = opts || {};
      tabs.forEach(function (t, i) {
        var on = t === tab;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.setAttribute('tabindex', on ? '0' : '-1');
        if (panels[i]) panels[i].hidden = !on;
      });
      if (opts.focus) tab.focus({ preventScroll: true });
      var panel = panels[tabs.indexOf(tab)];
      /* 탭을 바꾸면 문서 높이가 크게 달라지므로 먼저 맨 위로 올린 뒤,
         탭바 바로 아래에 패널 머리가 오도록 맞춥니다 */
      window.scrollTo({ top: 0, behavior: 'auto' });
      if (panel) {
        requestAnimationFrame(function () {
          panel.scrollIntoView({ block: 'start', behavior: 'auto' });
        });
      }
    }

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { activate(tab, { scroll: true }); });
      tab.addEventListener('keydown', function (e) {
        var idx = tabs.indexOf(tab);
        var next = null;
        if (e.key === 'ArrowRight') next = tabs[(idx + 1) % tabs.length];
        if (e.key === 'ArrowLeft') next = tabs[(idx - 1 + tabs.length) % tabs.length];
        if (e.key === 'Home') next = tabs[0];
        if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); activate(next, { focus: true, scroll: true }); }
      });
    });

    /* 페이지 안의 "이동" 버튼 */
    document.querySelectorAll('[data-goto]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = document.getElementById(btn.getAttribute('data-goto'));
        if (target) activate(target, { focus: true, scroll: true });
      });
    });

    /* 이직확인서 점검 결과가 채워지면 안내 문단은 숨김 */
    var docCheck = document.getElementById('doc-check');
    var docBefore = document.getElementById('doc-before');
    if (docCheck && docBefore) {
      var syncBefore = function () { docBefore.hidden = !docCheck.hidden; };
      new MutationObserver(syncBefore).observe(docCheck, { attributes: true, attributeFilter: ['hidden'] });
      syncBefore();
    }

    /* 결과가 나오면 계산 탭으로 (다른 탭에서 폼을 제출하는 경우 대비) */
    var form = document.getElementById('calc-form');
    if (form) {
      form.addEventListener('submit', function () {
        var calcTab = document.getElementById('tab-calc');
        var panel = document.getElementById('panel-calc');
        if (calcTab && panel && panel.hidden) activate(calcTab);
      });
    }

    /* 증거 체크 개수 */
    var evidence = Array.prototype.slice.call(document.querySelectorAll('.ev'));
    var countEl = document.getElementById('evidence-count');
    function refreshCount() {
      if (!countEl) return;
      var n = evidence.filter(function (el) { return el.checked; }).length;
      countEl.textContent = n + ' / ' + evidence.length + ' 챙겼어요';
    }
    evidence.forEach(function (el) { el.addEventListener('change', refreshCount); });
    refreshCount();

    /* 문장 복사 */
    var copyBtn = document.getElementById('copy-template');
    var template = document.getElementById('template-text');
    var statusEl = document.getElementById('template-status');
    if (copyBtn && template) {
      copyBtn.addEventListener('click', function () {
        var text = template.textContent;
        function done() { if (statusEl) statusEl.textContent = '복사했어요. 문자나 메일에 붙여 넣어 보세요.'; }
        function fallback() {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); done(); }
          catch (err) { if (statusEl) statusEl.textContent = '복사가 막혀 있어요. 문장을 길게 눌러 직접 복사해 주세요.'; }
          document.body.removeChild(ta);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else {
          fallback();
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
