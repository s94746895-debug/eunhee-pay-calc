/* 육아휴직·단축근무 정산 계산기
 * - 외부 라이브러리 없음. 모든 계산은 브라우저 안에서만.
 * - 순수 계산 함수는 window.Calc 로 노출해 테스트에서 직접 호출할 수 있음.
 * - 법령 기준: 2026년 11월 확인. 구직급여 상·하한은 이직일이 속한 해에 따라 자동 적용.
 */
(function () {
  'use strict';

  var RULES = {
    basis: '2026년 11월',
    annualCap: 25,
    leaveAttendanceFrom: '2018-05-29',  // 육아휴직 출근 간주 적용 개시
    shiftAttendanceFrom: '2024-10-22',  // 육아기 단축근무 출근 간주 적용 개시
    /* 이직일이 속한 해의 구직급여 기준 (최저임금 고시 · 고용보험법 시행령) */
    years: {
      2023: { minWage: 9620,  uiDailyMax: 66000, uiBaseMax: 110000, label: '2023년' },
      2024: { minWage: 9860,  uiDailyMax: 66000, uiBaseMax: 110000, label: '2024년' },
      2025: { minWage: 10030, uiDailyMax: 66000, uiBaseMax: 110000, label: '2025년' },
      2026: { minWage: 10320, uiDailyMax: 68100, uiBaseMax: 113500, label: '2026년' }
    }
  };

  var DAY = 86400000;

  /* ───────── 날짜 ───────── */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseDate(value) {
    if (!value) return null;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  function utc(d) { return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
  function diffDays(a, b) { return Math.round((utc(b) - utc(a)) / DAY); }
  function dateFromU(u) {
    var d = new Date(u);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function addMonths(d, n) {
    var y = d.getFullYear(), m = d.getMonth() + n, day = d.getDate();
    var last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(day, last));
  }

  function fmtDate(d) {
    return d ? d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()) : '';
  }

  function serviceText(days) {
    var y = Math.floor(days / 365);
    var rest = days - y * 365;
    var m = Math.floor(rest / 30.4);
    if (y <= 0) return days + '일(' + Math.max(0, m) + '개월)';
    return days + '일(' + y + '년' + (m > 0 ? ' ' + m + '개월' : '') + ')';
  }

  /* ───────── 숫자 ───────── */
  function toNum(v) {
    if (v === null || v === undefined) return 0;
    var n = Number(String(v).replace(/[^0-9]/g, ''));
    return isFinite(n) ? n : 0;
  }
  function comma(n) {
    var v = String(Math.round(n));
    return v.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function won(n) {
    var v = Math.abs(n);
    return (n < 0 ? '-' : '') + comma(v) + '원';
  }

  /* ───────── 연차 ───────── */
  function annualLeave(hire, quit) {
    var firstAnniv = addMonths(hire, 12);
    if (firstAnniv > quit) {
      /* 1년 미만: 1개월 개근 시 1일, 최대 11일 */
      var months = 0;
      for (var i = 1; i <= 12; i++) {
        if (addMonths(hire, i) <= quit) months = i; else break;
      }
      var d = Math.min(11, months);
      return { days: d, years: 0, months: months, label: '1년 미만 · 1개월 개근 시 1일(최대 11일) · ' + months + '개월' };
    }
    var years = 0;
    for (var y = 1; y <= 60; y++) {
      if (addMonths(hire, y * 12) <= quit) years = y; else break;
    }
    function ent(n) { return n >= 3 ? Math.min(RULES.annualCap, 15 + Math.floor((n - 1) / 2)) : 15; }
    return { days: ent(years), years: years, months: 0, label: '계속근로 ' + years + '년 · 연차 ' + ent(years) + '일' };
  }

  /* ───────── 임금 기초 ───────── */
  /* 주휴시간: 1주 소정근로시간에 비례(40시간에 8시간), 15시간 미만이면 0, 최대 8시간 */
  function weeklyHolidayHours(dailyHours, weekDays) {
    var weekly = dailyHours * weekDays;
    if (weekly < 15) return 0;
    return Math.min(8, weekly * 8 / 40);
  }

  function monthlyOrdinaryHours(dailyHours, weekDays) {
    var weekly = dailyHours * weekDays + weeklyHolidayHours(dailyHours, weekDays);
    var m = Math.round(weekly * 365 / 12 / 7);
    return m > 0 ? m : 209;
  }

  function wageBase(monthlyPay, dailyHours, weekDays) {
    var monthlyHours = monthlyOrdinaryHours(dailyHours, weekDays);
    var hourly = monthlyPay / monthlyHours;
    return {
      weeklyHours: dailyHours * weekDays,
      holidayHours: weeklyHolidayHours(dailyHours, weekDays),
      monthlyHours: monthlyHours,
      hourly: hourly,
      daily: hourly * dailyHours
    };
  }

  /* ───────── 구직급여 소정급여일수 ───────── */
  function benefitDaysFor(age, insuredGroup) {
    var over50 = age >= 50;
    var g = Number(insuredGroup);
    if (g === 0 || isNaN(g)) return 120;
    if (g === 1) return over50 ? 180 : 150;
    if (g === 2) return over50 ? 210 : 180;
    if (g === 3) return over50 ? 240 : 210;
    return over50 ? 270 : 240;
  }

  /* ───────── 이직일 기준 연도 ───────── */
  function yearRule(quit) {
    var y = quit.getFullYear();
    var rule, outOfRange = false, note = '';
    if (RULES.years[y]) {
      rule = RULES.years[y];
    } else if (y < 2023) {
      rule = RULES.years[2023];
      outOfRange = true;
      note = '이직일이 ' + y + '년이라 2023년 기준으로 계산했어요. 그 이전 이직자의 구직급여 상·하한은 달라서, 고용24 모의계산으로 확인해 주세요.';
    } else {
      rule = RULES.years[2026];
      outOfRange = true;
      note = '이직일이 ' + y + '년이라 2026년 기준으로 계산했어요. 그 뒤 해의 상·하한액이 고시되면 달라질 수 있습니다.';
    }
    return { key: y, rule: rule, outOfRange: outOfRange, note: note };
  }

  /* ───────── 기간 겹침 ───────── */
  function overlapDays(aStart, aEnd, bStart, bEnd) {
    var s = aStart > bStart ? aStart : bStart;
    var e = aEnd < bEnd ? aEnd : bEnd;
    if (e < s) return 0;
    return diffDays(s, e) + 1;
  }

  function overlapAll(ranges, start, end) {
    var s = utc(start), e = utc(end), sum = 0;
    ranges.forEach(function (r) {
      var a = Math.max(r.s, s), b = Math.min(r.e, e);
      if (b >= a) sum += Math.round((b - a) / DAY) + 1;
    });
    return sum;
  }

  function inRanges(u, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      if (u >= ranges[i].s && u <= ranges[i].e) return true;
    }
    return false;
  }

  /* 평균임금 산정기간
     - 기본: 이직일을 포함한 직전 3개월(91일)
     - 그 안에 휴직·단축기간이 있으면 그 일수를 빼고 남은 일수로 나눈다(근로기준법 시행령 제2조).
     - 3개월이 모두 제외기간이면, 그 제외기간이 시작되기 직전의 3개월로 옮긴다. */
  function averageWindow(hire, quit, ranges, target) {
    target = target || 91;
    var hireU = utc(hire);
    var endU = utc(quit);
    for (var guard = 0; guard < 60; guard++) {
      var startU = endU - (target - 1) * DAY;
      var clampedStart = startU < hireU ? hireU : startU;
      var span = Math.round((endU - clampedStart) / DAY) + 1;
      var excluded = 0, firstExcl = null;
      for (var u = clampedStart; u <= endU; u += DAY) {
        if (inRanges(u, ranges)) {
          excluded++;
          if (firstExcl === null) firstExcl = u;
        }
      }
      var days = span - excluded;
      if (days > 0) {
        return {
          start: dateFromU(clampedStart), end: dateFromU(endU),
          days: days, excludedDays: excluded, span: span,
          full: span >= target, movedBack: guard > 0
        };
      }
      if (firstExcl === null) break;
      /* 3개월이 통째로 제외기간이면, 그 제외기간이 이어지는 구간의 시작 직전으로 한 번에 옮긴다. */
      var runStart = clampedStart;
      while (runStart - DAY >= hireU && inRanges(runStart - DAY, ranges)) runStart -= DAY;
      endU = runStart - DAY;
      if (endU < hireU) break;
    }
    return {
      start: hire, end: quit, days: 1, excludedDays: 0, span: 0,
      full: false, movedBack: true
    };
  }

  /* 피보험단위기간 추정: (근로일 + 주휴일) 비율로 환산 */
  function insuredUnitsFor(start, end, weekDays, hasHoliday, leaveRanges) {
    var total = diffDays(start, end) + 1;
    if (total <= 0) return 0;
    var leave = overlapAll(leaveRanges, start, end);
    var active = Math.max(0, total - leave);
    var perWeek = weekDays + (hasHoliday ? 1 : 0);
    return Math.round(active * perWeek / 7);
  }

  /* ───────── 카드 정의 ───────── */
  var CARD_META = {
    annual: {
      no: 1,
      title: '미사용 연차수당',
      law: '근로기준법 제60조 제6항',
      body: '2018년 5월 29일 이후에 시작한 육아휴직 기간과 2024년 10월 22일 이후에 시작한 육아기 단축근무 기간은 연차 계산에서 ‘출근한 것’으로 봅니다. 그래서 휴직·단축을 지나도 연차가 줄지 않고, 퇴사할 때 남은 연차는 수당으로 정산돼요. (상시 5인 이상 사업장)',
      more: '연차수당은 취업규칙 등에 별도 규정이 없으면 통상임금으로 계산하고, 기준은 ‘휴가청구권이 있는 마지막 달’의 통상임금이에요. 1일 통상임금 = 통상시급 × 1일 소정근로시간입니다. 단축근무 중 연차를 사용했다면 사용한 날의 단축된 시간만큼 차감될 수 있으니, 회사 연차대장의 사용 내역도 함께 확인해 보세요. 2024년 10월 22일 전에 시작한 단축근무 기간은 단축된 시간에 비례해 연차가 발생하므로, 위 일수보다 적을 수 있습니다. 이 계산기는 회계연도 기준 사업장의 이월 연차를 따로 반영하지 않으니, 남아 있는 연차는 직접 더해 주세요.'
    },
    leave: {
      no: 2,
      title: '퇴직금 · 육아휴직 기간',
      law: '남녀고용평등법 제19조 제4항 · 근로기준법 시행령 제2조',
      body: '퇴직금은 입사일부터 퇴사일까지의 ‘계속근로기간’ 전체로 계산합니다. 육아휴직 기간도 여기에 들어가요. 대신 평균임금을 낼 때는 휴직기간과 그 기간에 받은 임금을 빼고 계산하도록 되어 있어서, 휴직 때문에 퇴직금이 깎이지 않습니다.',
      more: '평균임금이 통상임금보다 적으면 통상임금을 평균임금으로 봅니다(근로기준법 제2조 제2항). 회사가 평균임금을 낼 때 휴직기간을 빼지 않아 금액이 낮아졌다면, 통상임금 기준으로 다시 계산해야 해요. 퇴직금 계산서의 ‘재직일수’가 실제 근무기간보다 짧게 적혀 있는지 먼저 확인해 보세요. 평균임금에는 3개월 안에 지급된 상여금·연차수당이 그대로 들어가고, 1년 이상의 기간에 대한 상여금은 3/12로 환산해 더합니다(근로기준법 시행령 제2조 제2항). 급여명세서에 상여금이 찍혀 있다면 그 금액도 함께 넣어 주세요.'
    },
    shift: {
      no: 3,
      title: '퇴직금 · 육아기 단축근무',
      law: '남녀고용평등법 제19조의3 제4항 · 근로기준법 제2조',
      body: '육아기 근로시간 단축 기간도 평균임금 계산에서는 빠집니다. 그리고 평균임금이 통상임금보다 적으면 통상임금으로 계산하는데, 이때 통상임금은 단축 전 소정근로시간을 기준으로 해요. 단축이 끝나자마자 퇴사하거나 단축 중에 퇴사해도 단축된 시간 기준으로 깎으면 안 됩니다.',
      more: '실무에서는 단축 직후 퇴사한 경우 단축된 급여로 평균임금을 내 퇴직금이 줄어드는 사례가 있어요. 이때는 단축 전 임금으로 다시 계산한 금액과의 차액을 청구할 수 있습니다. 회사가 단축 후 근로시간으로 통상임금을 계산했다면 그것도 함께 확인하세요. 단축 후 시간급이 단축 전보다 높다면 ‘시간급은 퇴직 당시 기준’이라는 해석에 따라 금액이 1% 안팎 달라질 수 있어요.'
    },
    extra: {
      no: 4,
      title: '단축근무 중 초과근무 수당',
      law: '기간제법 제6조 제3항 · 남녀고용평등법 제19조의3 제3항',
      body: '단축된 소정근로시간을 넘겨 일한 시간은 통상임금의 50% 이상을 더 받아요(총 150%). 회사는 원칙적으로 단축된 시간 외 연장근로를 요구할 수 없고, 근로자가 명시적으로 청구할 때만 주 12시간 이내로 가능합니다.',
      more: '아래 금액은 50% 가산만 반영한 값이에요. 밤 10시부터 오전 6시 사이의 야간근로에는 0.5배가 더 붙고, 휴일근로는 8시간 이내 0.5배·8시간 초과분 1.0배가 더 붙으므로, 야간이나 휴일 근무가 섞여 있다면 실제 미지급액은 이보다 클 수 있습니다. 휴일·야간 시간을 따로 적어 두었다면 1350에 함께 문의해 보세요. 초과근무 수당을 한 번도 받지 않았다면 받은 수당을 0원으로 두고 계산해 보세요. 출퇴근 기록, 업무 지시 메신저, 업무일지를 남겨 두면 청구에 도움이 됩니다.'
    },
    unemp: {
      no: 5,
      title: '실업급여(구직급여) 기초일액',
      law: '고용보험법 제45조 · 제46조',
      body: '구직급여 1일액은 이직 전 평균임금(통상임금이 더 크면 통상임금)의 60%로 정하고, 최저임금의 80%에 1일 소정근로시간을 곱한 금액과 법정 상한 사이로 맞춥니다. 육아휴직·단축근무 기간은 평균임금에서 빠지므로, 회사가 단축 급여나 단축된 시간으로 이직확인서를 내면 1일액이 낮아질 수 있어요. 어느 기준이 적용되는지는 관할 고용센터가 판단하므로, 아래에 두 경우를 나란히 보여 드립니다.',
      more: '최저기초일액을 ‘단축 후 1일 소정근로시간’으로 볼지, ‘단축 전 소정근로시간’으로 볼지에 대해서는 해석이 갈립니다. 고용보험법 시행령의 문언은 이직 전 1일 소정근로시간을 기준으로 하고, 일부 노무 해석은 단축 때문에 불이익을 받지 않도록 단축 전 시간을 적용해야 한다고 봅니다. 그래서 이 계산기는 두 경우를 나란히 보여 드립니다. 실제 적용은 관할 고용센터의 판단을 확인하세요. 2026년 이직자는 상한 68,100원·하한 66,048원(1일 8시간), 2025년 이직자는 상한 66,000원·하한 64,192원이고, 상·하한 차이는 하루 2,052원(2025년 1,808원)입니다. 하한은 1일 소정근로시간에 비례하므로(6시간이면 2026년 49,536원), 신고된 시간이 짧을수록 1일액도 낮아집니다.'
    }
  };

  var REASON_LIST = [
    { code: '11', label: '11 · 개인사정으로 인한 자진퇴사' },
    { code: '12', label: '12 · 사업장 이전·근로조건 변동·임금체불 등으로 자진퇴사' },
    { code: '22', label: '22 · 폐업·도산(예정 포함), 공사 중단' },
    { code: '23', label: '23 · 경영상 필요 또는 회사불황으로 인한 인원감축 등(해고·권고사직 포함)' },
    { code: '26', label: '26 · 근로자 귀책사유에 의한 징계해고·권고사직' },
    { code: '31', label: '31 · 정년' },
    { code: '32', label: '32 · 계약기간 만료, 공사 종료' },
    { code: '41', label: '41 · 고용보험 비적용' }
  ];

  function reasonLabel(code) {
    for (var i = 0; i < REASON_LIST.length; i++) if (REASON_LIST[i].code === code) return REASON_LIST[i].label;
    return '';
  }

  /* ───────── 메인 계산 ───────── */
  function compute(input) {
    input = input || {};
    var errors = [];
    var warnings = [];

    var hire = parseDate(input.hireDate);
    var quit = parseDate(input.quitDate);
    if (!hire) errors.push({ field: 'hireDate', message: '입사일을 입력해 주세요.' });
    if (!quit) errors.push({ field: 'quitDate', message: '퇴사일(예정일)을 입력해 주세요.' });
    if (hire && quit && diffDays(hire, quit) <= 0) {
      errors.push({ field: 'quitDate', message: '퇴사일은 입사일보다 뒤여야 해요.' });
    }

    var pay = toNum(input.monthlyPay);
    if (pay <= 0) errors.push({ field: 'monthlyPay', message: '월 급여(세전)를 입력해 주세요.' });

    var dailyHours = toNum(input.dailyHours) || 8;
    if (dailyHours < 1 || dailyHours > 12) {
      errors.push({ field: 'dailyHours', message: '1일 소정근로시간은 1~12시간 사이로 입력해 주세요.' });
    }
    var weekDays = toNum(input.weekDays) || 5;
    if (weekDays < 1 || weekDays > 7) {
      errors.push({ field: 'weekDays', message: '주 소정근로일수는 1~7일 사이로 입력해 주세요.' });
    }

    var pensionType = input.pensionType === 'db' || input.pensionType === 'dc' ? input.pensionType : 'severance';

    /* 육아휴직 기간 */
    var leaves = [];
    (input.leaves || []).forEach(function (row, idx) {
      row = row || {};
      var hasAny = !!String(row.start || '').trim() || !!String(row.end || '').trim();
      if (!hasAny) return;
      var s = parseDate(row.start), e = parseDate(row.end);
      if (!s || !e) {
        errors.push({ field: 'leave-' + idx, message: '육아휴직 ' + (idx + 1) + '번째 기간의 시작일과 종료일을 모두 입력해 주세요.' });
        return;
      }
      if (e < s) {
        errors.push({ field: 'leave-' + idx, message: '육아휴직 ' + (idx + 1) + '번째 기간의 종료일이 시작일보다 빠릅니다.' });
        return;
      }
      if (hire && s < hire) {
        errors.push({ field: 'leave-' + idx, message: '육아휴직 기간은 입사일 이후여야 해요.' });
        return;
      }
      if (quit && e > quit) {
        errors.push({ field: 'leave-' + idx, message: '육아휴직 기간은 퇴사일 이전이어야 해요.' });
        return;
      }
      leaves.push({ start: s, end: e, days: diffDays(s, e) + 1 });
    });

    /* 육아기 근로시간 단축 */
    var shiftStart = parseDate(input.shiftStart);
    var shiftEnd = parseDate(input.shiftEnd);
    var shiftHoursRaw = String(input.shiftHours == null ? '' : input.shiftHours).trim();
    var shiftWeekDaysRaw = String(input.shiftWeekDays == null ? '' : input.shiftWeekDays).trim();
    var shiftHours = shiftHoursRaw === '' ? dailyHours : toNum(shiftHoursRaw);
    var shiftWeekDays = shiftWeekDaysRaw === '' ? weekDays : toNum(shiftWeekDaysRaw);
    var shiftPay = toNum(input.shiftPay);
    var extraHours = toNum(input.extraHours);
    var extraPaid = toNum(input.extraPaid);

    var hasShiftInput = !!String(input.shiftStart || '').trim() || !!String(input.shiftEnd || '').trim() ||
      shiftHoursRaw !== '' || shiftWeekDaysRaw !== '' ||
      !!String(input.shiftPay || '').trim() || extraHours > 0;

    var shift = null;
    if (hasShiftInput) {
      if (!shiftStart || !shiftEnd) {
        errors.push({ field: 'shiftStart', message: '단축근무 기간의 시작일과 종료일을 모두 입력해 주세요.' });
      } else if (shiftEnd < shiftStart) {
        errors.push({ field: 'shiftEnd', message: '단축 종료일이 시작일보다 빠릅니다.' });
      } else if (hire && shiftStart < hire) {
        errors.push({ field: 'shiftStart', message: '단축근무 기간은 입사일 이후여야 해요.' });
      } else if (quit && shiftEnd > quit) {
        errors.push({ field: 'shiftEnd', message: '단축근무 기간은 퇴사일 이전이어야 해요.' });
      }
      if (shiftHours <= 0 || shiftHours > 12) {
        errors.push({ field: 'shiftHours', message: '단축 후 1일 근로시간은 1~12시간 사이로 입력해 주세요.' });
      } else if (shiftHours > dailyHours) {
        errors.push({ field: 'shiftHours', message: '단축 후 1일 근로시간은 단축 전(' + dailyHours + '시간)보다 길 수 없어요.' });
      }
      if (shiftWeekDays < 1 || shiftWeekDays > 7) {
        errors.push({ field: 'shiftWeekDays', message: '단축 후 주 소정근로일수는 1~7일 사이로 입력해 주세요.' });
      } else if (shiftWeekDays > weekDays) {
        errors.push({ field: 'shiftWeekDays', message: '단축 후 주 소정근로일수는 단축 전(' + weekDays + '일)보다 많을 수 없어요.' });
      }
      if (shiftHours === dailyHours && shiftWeekDays === weekDays) {
        errors.push({ field: 'shiftHours', message: '단축 후 근로시간과 근로일수를 비우면 단축 전과 같아져요. 단축한 시간(예: 6시간)이나 일수(예: 4일) 중 하나는 입력해 주세요.' });
      }
      if (shiftPay <= 0) {
        errors.push({ field: 'shiftPay', message: '단축 중 월 급여를 입력해 주세요.' });
      }
      if (!errors.length && shiftStart && shiftEnd && shiftEnd >= shiftStart) {
        shift = {
          start: shiftStart, end: shiftEnd, hours: shiftHours, weekDays: shiftWeekDays,
          pay: shiftPay, hoursRaw: shiftHoursRaw, weekDaysRaw: shiftWeekDaysRaw,
          days: diffDays(shiftStart, shiftEnd) + 1,
          extraHours: extraHours, extraPaid: extraPaid
        };
      }
    }

    /* 연차 */
    var auto = (hire && quit && diffDays(hire, quit) > 0) ? annualLeave(hire, quit) : null;
    var annualDaysRaw = String(input.annualDays == null ? '' : input.annualDays).trim();
    var annualDays = annualDaysRaw === '' ? (auto ? auto.days : 0) : toNum(annualDaysRaw);
    var annualUsed = toNum(input.annualUsed);
    if (annualUsed > annualDays) {
      warnings.push({ type: 'info', text: '사용한 연차가 발생 연차보다 많아 미사용 연차는 0일로 계산했어요. 발생 연차를 확인해 주세요.' });
    }

    var benefitDays = toNum(input.uiBenefitDays) || 150;
    if (benefitDays < 1 || benefitDays > 270) {
      errors.push({ field: 'uiBenefitDays', message: '소정급여일수는 1~270일 사이로 입력해 주세요.' });
    }

    if (errors.length) return { ok: false, errors: errors };

    /* ── 기준 연도 ── */
    var yr = yearRule(quit);
    if (yr.outOfRange) warnings.push({ type: 'warn', text: yr.note });

    /* ── 산정 기초 ── */
    var serviceDays = diffDays(hire, quit) + 1;
    var base = wageBase(pay, dailyHours, weekDays);
    var preWeeklyHours = dailyHours * weekDays;
    var holidayHours = weeklyHolidayHours(dailyHours, weekDays);
    var hasHoliday = holidayHours > 0;

    /* 평균임금 산정기간: 휴직·단축기간 제외 */
    var exRanges = leaves.map(function (r) { return { s: utc(r.start), e: utc(r.end), kind: 'leave' }; });
    if (shift) exRanges.push({ s: utc(shift.start), e: utc(shift.end), kind: 'shift' });
    var win = averageWindow(hire, quit, exRanges, 91);

    var threeMonth = toNum(input.threeMonthTotal);
    var avgDaily = threeMonth > 0 ? threeMonth / win.days : pay * 12 / 365;
    var lawfulDaily = Math.max(avgDaily, base.daily);
    var severanceTotal = lawfulDaily * 30 * serviceDays / 365;

    var leaveDays = leaves.reduce(function (s, r) { return s + r.days; }, 0);

    var rows = [];
    var below15 = preWeeklyHours < 15;
    var oneYearPlus = addMonths(hire, 12) <= quit;
    var noSeverance = !oneYearPlus || below15;

    /* 1. 연차수당 */
    var unused = Math.max(0, annualDays - annualUsed);
    var annualApplicable = unused > 0 && !below15;
    rows.push({
      id: 'annual', group: 'annual', title: '미사용 연차수당',
      amount: annualApplicable ? Math.round(unused * base.daily) : 0,
      applicable: annualApplicable, checked: annualApplicable,
      detail: unused > 0
        ? '미사용 ' + unused + '일 × 1일 통상임금 ' + won(base.daily) + ' (통상시급 ' + won(base.hourly) + ' × ' + dailyHours + '시간)'
        : '사용한 연차가 발생 연차보다 많거나 같아 미사용 연차가 없어요.'
    });

    /* 2. 육아휴직 기간이 근속에서 빠진 경우 */
    var leavePeriodAmount = (leaveDays > 0 && !noSeverance)
      ? Math.round(lawfulDaily * 30 * leaveDays / 365) : 0;
    rows.push({
      id: 'leavePeriod', group: 'leave',
      title: pensionType === 'dc' ? '육아휴직 기간을 부담금 산정에서 뺐다면' : '육아휴직 기간을 근속에서 뺐다면',
      amount: leavePeriodAmount, applicable: leavePeriodAmount > 0, checked: leavePeriodAmount > 0,
      detail: leaveDays > 0
        ? '휴직 ' + leaveDays + '일 × 1일 평균임금 ' + won(lawfulDaily) + ' × 30일 ÷ 365일'
        : '육아휴직 기간이 입력되지 않았어요.'
    });

    /* 3. 단축근무 퇴직금 */
    var shiftData = null;
    var shiftAmount = 0;
    if (shift) {
      var shiftBase = wageBase(shift.pay, shift.hours, shift.weekDays);
      var shiftCompanyDaily = Math.max(shift.pay * 12 / 365, shiftBase.daily);
      var perDay = Math.max(0, lawfulDaily - shiftCompanyDaily);
      shiftAmount = noSeverance ? 0 : Math.round(perDay * 30 * serviceDays / 365);
      shiftData = {
        hourly: shiftBase.hourly, daily: shiftBase.daily,
        companyDaily: shiftCompanyDaily, perDay: perDay, days: shift.days,
        start: shift.start, end: shift.end, hours: shift.hours, weekDays: shift.weekDays,
        pay: shift.pay, weeklyHours: shift.hours * shift.weekDays,
        holidayHours: weeklyHolidayHours(shift.hours, shift.weekDays)
      };
      rows.push({
        id: 'shiftSeverance', group: 'shift',
        title: pensionType === 'dc' ? '단축 급여 기준으로 부담금을 넣었다면' : '단축 급여 기준으로 계산됐다면',
        amount: shiftAmount, applicable: shiftAmount > 0, checked: shiftAmount > 0,
        detail: perDay > 0
          ? '1일 차이 ' + won(perDay) + ' × 30일 × 재직 ' + serviceDays + '일 ÷ 365일'
          : '단축 전 기준으로 계산하면 이미 충분히 지급된 것으로 보여요. 다만 회사가 단축 후 급여만으로 평균임금을 내고 통상임금 보정을 하지 않았다면 차액이 생길 수 있으니, 퇴직금 계산서를 확인해 보세요.'
      });
    } else {
      rows.push({
        id: 'shiftSeverance', group: 'shift',
        title: '단축 급여 기준으로 계산됐다면',
        amount: 0, applicable: false, checked: false,
        detail: '육아기 단축근무 기간이 입력되지 않았어요.'
      });
    }

    /* 4. 초과근무 수당 */
    var extraAmount = 0, extraGross = 0;
    var extraHourly = shift && shiftData ? shiftData.hourly : base.hourly;
    if (shift && shift.extraHours > 0) {
      extraGross = shift.extraHours * extraHourly * 1.5;
      extraAmount = Math.max(0, Math.round(extraGross - shift.extraPaid));
    }
    rows.push({
      id: 'extraPay', group: 'extra', title: '초과근무 가산수당 미지급분',
      amount: extraAmount, applicable: extraAmount > 0, checked: extraAmount > 0,
      detail: (shift && shift.extraHours > 0)
        ? shift.extraHours + '시간 × 단축 중 통상시급 ' + won(extraHourly) + ' × 150%' + (shift.extraPaid > 0 ? ' − 받은 수당 ' + won(shift.extraPaid) : '')
        : '초과근무 시간이 입력되지 않았어요.'
    });

    /* 5. 실업급여 */
    var docDailyHoursRaw = String(input.docDailyHours == null ? '' : input.docDailyHours).trim();
    var filedHours = docDailyHoursRaw === '' ? (shift ? shift.hours : dailyHours) : toNum(docDailyHoursRaw);
    if (filedHours < 1 || filedHours > 12) {
      warnings.push({ type: 'info', text: '이직확인서상 1일 소정근로시간이 1~12시간 범위를 벗어나 입력값을 무시했어요.' });
      filedHours = shift ? shift.hours : dailyHours;
    }
    var reportedPay = toNum(input.uiReportedPay) || (shift ? shift.pay : pay);
    var reportedHourly = shift && shiftData ? shiftData.hourly : base.hourly;
    var docAvgDaily = toNum(input.docAvgDaily);
    var reportedDaily = docAvgDaily > 0
      ? docAvgDaily
      : Math.max(reportedPay * 12 / 365, reportedHourly * filedHours);

    var floorFiled = yr.rule.minWage * 0.8 * filedHours;
    var floorPre = yr.rule.minWage * 0.8 * dailyHours;
    var baseFiled = Math.min(yr.rule.uiBaseMax, reportedDaily);
    var basePre = Math.min(yr.rule.uiBaseMax, lawfulDaily);

    function benefitDaily(baseDaily, floor) {
      var v = Math.max(floor, baseDaily * 0.6);
      return Math.round(Math.min(yr.rule.uiDailyMax, v));
    }
    var dFiled = benefitDaily(baseFiled, floorFiled);
    var dPre = benefitDaily(basePre, floorPre);
    var perDayDiff = Math.max(0, dPre - dFiled);
    var uiDiff = perDayDiff * benefitDays;

    rows.push({
      id: 'uiDiff', group: 'unemp',
      title: shift ? '이직확인서를 단축 전 기준으로 정정했을 때' : '기초일액을 낮게 신고했다면',
      amount: Math.round(uiDiff), applicable: uiDiff > 0, checked: uiDiff > 0,
      detail: uiDiff > 0
        ? '1일 ' + won(dPre) + ' − 신고 기준 ' + won(dFiled) + ' = ' + won(perDayDiff) + ' × ' + benefitDays + '일'
        : '이 조건에서는 두 기준의 1일 금액이 같아 차액이 없어요.'
    });

    /* ── 계산 중 확인 사항 ── */
    if (!oneYearPlus) {
      warnings.push({ type: 'warn', text: '계속근로기간이 1년 미만(' + serviceDays + '일)이라 법정 퇴직금은 발생하지 않아요. 퇴직금 항목은 0원으로 계산했습니다.' });
    }
    if (below15) {
      warnings.push({ type: 'warn', text: '주 소정근로시간이 15시간 미만이면 퇴직금과 연차유급휴가 규정이 적용되지 않아요.' });
    }
    if (win.movedBack) {
      warnings.push({
        type: 'warn',
        text: '퇴직 전 3개월이 모두 육아휴직·단축기간이라, 그 기간이 시작되기 전 3개월(' +
          fmtDate(win.start) + '~' + fmtDate(win.end) + ', ' + win.days + '일)을 평균임금 산정기간으로 잡았어요.' +
          (threeMonth > 0 ? ' 임금 총액도 이 기간 기준으로 입력했는지 확인해 주세요.' : '')
      });
    } else if (win.excludedDays > 0) {
      warnings.push({
        type: 'warn',
        text: '퇴직 전 3개월 중 육아휴직·단축기간 ' + win.excludedDays + '일을 빼고, 남은 ' + win.days + '일로 평균임금을 계산했어요.' +
          (threeMonth > 0 ? ' 임금 총액도 그 기간에 받은 임금을 빼고 입력했는지 확인해 주세요.' : '')
      });
    }
    if (!win.full) {
      warnings.push({ type: 'info', text: '산정기간이 3개월이 되지 않아(' + win.days + '일), 입사일 이후 기간만으로 평균임금을 계산했어요.' });
    }
    leaves.forEach(function (r) {
      if (r.start < parseDate(RULES.leaveAttendanceFrom)) {
        warnings.push({ type: 'info', text: '2018년 5월 29일 전에 시작한 육아휴직 기간은 연차 산정 때 출근으로 보지 않아요. 그만큼 연차가 적게 발생할 수 있습니다.' });
      }
    });
    if (shift && shift.start < parseDate(RULES.shiftAttendanceFrom)) {
      warnings.push({ type: 'info', text: '2024년 10월 22일 전에 시작한 단축근무 기간은 연차를 단축된 시간에 비례해 계산해요. 위 연차일수는 단축 전 기준으로 계산한 값이니, 해당 기간이 있으면 발생 연차를 직접 낮춰 주세요.' });
    }
    if (shift && shift.pay >= pay) {
      warnings.push({ type: 'warn', text: '단축 중 월 급여가 단축 전보다 크거나 같아요. 급여 입력값을 확인해 주세요.' });
    }
    if (shift && shiftData && shift.weeklyHours > 0 && shift.weeklyHours < 15) {
      warnings.push({ type: 'info', text: '단축 후 주 소정근로시간이 15시간 미만이면 일부 규정 적용이 달라질 수 있어요.' });
    }
    if (pensionType === 'dc') {
      warnings.push({ type: 'warn', text: '확정기여형(DC)은 퇴사할 때 한꺼번에 정산하는 제도가 아니라, 회사가 매년 부담금을 넣는 제도예요. 아래 퇴직금 항목은 ‘신고된 임금을 기준으로 부담금을 계산했다면 그만큼 적게 들어갔을 수 있다’는 뜻으로 읽어 주세요. 실제 납입 내역은 가입한 금융기관이나 근로복지공단에서 확인할 수 있어요.' });
    } else if (pensionType === 'db') {
      warnings.push({ type: 'info', text: '확정급여형(DB)은 퇴직할 때 받을 급여가 미리 정해진 제도예요. 회사가 계산한 퇴직급여 산정서와 위 금액을 비교해 보세요.' });
    }

    /* ── 합계 ── */
    var total = rows.reduce(function (s, r) { return s + (r.applicable && r.checked ? r.amount : 0); }, 0);

    var summaryBits = [];
    summaryBits.push('재직 ' + serviceText(serviceDays));
    summaryBits.push('1일 통상임금 ' + won(base.daily));
    summaryBits.push('월 소정근로시간 ' + base.monthlyHours + '시간' + (hasHoliday ? '(주휴 ' + holidayHours + '시간 포함)' : ''));
    if (leaveDays > 0) summaryBits.push('육아휴직 ' + leaveDays + '일');
    if (shift) summaryBits.push('단축근무 ' + shift.days + '일(1일 ' + shift.hours + '시간·주 ' + shift.weekDays + '일)');

    /* 이직확인서 4칸 점검 */
    var insuredStart = addMonths(quit, -18);
    if (hire > insuredStart) insuredStart = hire;
    var leaveRanges = leaves.map(function (r) { return { s: utc(r.start), e: utc(r.end) }; });
    var insuredEstimate = insuredUnitsFor(insuredStart, quit, weekDays, hasHoliday, leaveRanges);
    var docCheck = buildDocCheck({
      docReason: String(input.docReason || ''),
      myReason: String(input.myReason || ''),
      docInsuredDays: toNum(input.docInsuredDays),
      docAvgDaily: docAvgDaily,
      docDailyHoursRaw: docDailyHoursRaw,
      filedHours: filedHours,
      dailyHours: dailyHours,
      lawfulDaily: lawfulDaily,
      insuredEstimate: insuredEstimate,
      insuredStart: insuredStart,
      shift: !!shift,
      quit: quit
    });

    var ctx = {
      lawfulDaily: lawfulDaily, base: base, serviceDays: serviceDays,
      baseFiled: Math.round(baseFiled), basePre: Math.round(basePre),
      dFiled: dFiled, dPre: dPre, benefitDays: benefitDays,
      floorFiled: floorFiled, floorPre: floorPre, filedHours: filedHours,
      dailyHours: dailyHours, yearLabel: yr.rule.label,
      uiDailyMax: yr.rule.uiDailyMax, floor8: Math.round(yr.rule.minWage * 0.8 * 8),
      minWage: yr.rule.minWage, reportWindow: win
    };

    return {
      ok: true,
      meta: {
        basisYear: yr.key, basisLabel: yr.rule.label,
        dailyMax: yr.rule.uiDailyMax, dailyMin: Math.round(yr.rule.minWage * 0.8 * 8),
        serviceDays: serviceDays, serviceText: serviceText(serviceDays),
        weeklyHours: preWeeklyHours, holidayHours: holidayHours,
        monthlyHours: base.monthlyHours, hourly: base.hourly, dailyOrdinary: base.daily,
        windowStart: win.start, windowEnd: win.end, windowDays: win.days,
        windowExcluded: win.excludedDays, windowFull: win.full,
        threeMonthUsed: threeMonth,
        avgDaily: avgDaily, lawfulDaily: lawfulDaily,
        severanceTotal: Math.round(severanceTotal), leaveDays: leaveDays,
        shiftDays: shift ? shift.days : 0, shiftData: shiftData,
        benefitDays: benefitDays, dFiled: dFiled, dPre: dPre,
        baseFiled: Math.round(baseFiled), basePre: Math.round(basePre),
        floorFiled: floorFiled, floorPre: floorPre, filedHours: filedHours,
        pensionType: pensionType,
        insuredEstimate: insuredEstimate,
        annual: { days: annualDays, used: annualUsed, unused: unused, auto: auto ? auto.days : 0, label: auto ? auto.label : '' },
        noSeverance: noSeverance
      },
      warnings: warnings,
      rows: rows,
      cards: buildCards(rows, shiftData, ctx),
      docCheck: docCheck,
      summary: summaryBits.join(' · '),
      total: total
    };
  }

  /* ───────── 이직확인서 4칸 점검 ───────── */
  function buildDocCheck(c) {
    var items = [];

    /* ① 이직사유 */
    var doc = c.docReason, mine = c.myReason;
    var docLabel = reasonLabel(doc), myLabel = reasonLabel(mine);
    if (!doc && !mine) {
      items.push({
        no: 1, title: '이직사유', status: 'unknown',
        actual: '이직확인서 사본에서 확인해 주세요',
        expected: '실제 퇴사 경위를 고르면 비교해 드려요',
        message: '이직확인서의 이직사유가 실제 퇴사 경위와 다르면 실업급여 수급자격 자체가 막힐 수 있어요. 가장 흔한 다툼이 ‘권고사직인데 자진퇴사(11)로 적힌’ 경우입니다.'
      });
    } else if (!doc) {
      items.push({
        no: 1, title: '이직사유', status: 'unknown',
        actual: '이직확인서 사본에서 확인해 주세요',
        expected: myLabel,
        message: '이직확인서에 적힌 이직사유를 확인해 주세요. 실제 퇴사 경위와 다르면 정정 대상입니다.'
      });
    } else if (!mine) {
      items.push({
        no: 1, title: '이직사유', status: 'unknown',
        actual: docLabel,
        expected: '실제 퇴사 경위를 골라 주세요',
        message: '실제 퇴사 경위를 고르면 이직확인서 기재와 비교해 드려요.'
      });
    } else if (doc === mine) {
      items.push({
        no: 1, title: '이직사유', status: 'ok',
        actual: docLabel, expected: myLabel,
        message: '기재된 사유와 실제 퇴사 경위가 같아요. 이직사유만으로는 문제가 없습니다.'
      });
    } else {
      var risky = doc === '11' && (mine === '23' || mine === '22' || mine === '26' || mine === '32' || mine === '31');
      items.push({
        no: 1, title: '이직사유', status: risky ? 'risk' : 'warn',
        actual: docLabel, expected: myLabel,
        message: risky
          ? '자진퇴사(11)로 적혀 있으면 원칙적으로 구직급여 수급자격이 인정되지 않아요. 다만 육아·출산·질병·통근 곤란처럼 고용보험법 시행령이 정한 정당한 사유가 있으면 11로 적혀 있어도 인정될 수 있습니다. 회사가 권유해 그만둔 것이라면 23(경영상 인원감축·권고사직 포함)으로 정정하는 것이 맞고, 사직서에 ‘개인 사정’이라고 썼더라도 실제 경위를 자료로 보여 주면 다투어 볼 수 있어요.'
          : '이직확인서의 이직사유가 실제 퇴사 경위와 달라요. 사실과 다르게 적힌 이직확인서는 정정 대상이고, 거짓 기재에는 과태료가 붙을 수 있습니다.'
      });
    }

    /* ② 피보험단위기간 */
    if (c.docInsuredDays > 0) {
      if (c.docInsuredDays < 180 && c.insuredEstimate >= 180) {
        items.push({
          no: 2, title: '피보험단위기간', status: 'risk',
          actual: c.docInsuredDays + '일', expected: '추정 ' + c.insuredEstimate + '일(180일 이상)',
          message: '180일 미달로 적혀 있지만, 입력한 기간으로 계산한 추정치는 180일을 넘어요. 실제 근로일수(주휴일 포함)를 세어 보고 정정을 요청하세요.'
        });
      } else if (c.docInsuredDays < 180) {
        items.push({
          no: 2, title: '피보험단위기간', status: 'warn',
          actual: c.docInsuredDays + '일', expected: '추정 ' + c.insuredEstimate + '일',
          message: '180일 미달이면 구직급여 수급자격이 어려울 수 있어요(이직 전 18개월 동안 통산). 휴직기간은 이 기간에서 빠지니, 휴직 전 다른 사업장 이력이 통산되는지 함께 확인해 보세요.'
        });
      } else {
        items.push({
          no: 2, title: '피보험단위기간', status: 'ok',
          actual: c.docInsuredDays + '일', expected: '추정 ' + c.insuredEstimate + '일',
          message: '180일 이상으로 적혀 있어요. 수급자격의 이 요건은 문제가 없습니다.'
        });
      }
    } else {
      items.push({
        no: 2, title: '피보험단위기간', status: 'unknown',
        actual: '이직확인서 사본에서 확인해 주세요',
        expected: '추정 ' + c.insuredEstimate + '일',
        message: '이직 전 18개월(' + fmtDate(c.insuredStart) + '~' + fmtDate(c.quit) + ') 동안 보수를 받은 날이 180일 이상이어야 해요. 근로일과 주휴일을 더해 세고, 휴직기간은 빠집니다.'
      });
    }

    /* ③ 평균임금 */
    if (c.docAvgDaily > 0) {
      var d = Math.round(c.lawfulDaily - c.docAvgDaily);
      if (d > 1000) {
        items.push({
          no: 3, title: '평균임금(1일)', status: 'warn',
          actual: won(c.docAvgDaily), expected: won(Math.round(c.lawfulDaily)) + ' (계산값)',
          message: '기재된 1일 평균임금이 계산값보다 ' + won(d) + ' 낮아요. 휴직·단축기간을 빼지 않았거나, 상여금·연차수당을 넣지 않은 경우가 많습니다.'
        });
      } else {
        items.push({
          no: 3, title: '평균임금(1일)', status: 'ok',
          actual: won(c.docAvgDaily), expected: won(Math.round(c.lawfulDaily)) + ' (계산값)',
          message: '기재된 금액이 계산값보다 낮지 않아요. 이 항목으로 손해 볼 여지는 크지 않습니다.'
        });
      }
    } else {
      items.push({
        no: 3, title: '평균임금(1일)', status: 'unknown',
        actual: '이직확인서 사본에서 확인해 주세요',
        expected: won(Math.round(c.lawfulDaily)) + ' (계산값)',
        message: '평균임금은 휴직·단축기간을 빼고, 3개월 안에 지급된 상여금·연차수당을 넣어 계산해요.'
      });
    }

    /* ④ 1일 소정근로시간 */
    if (c.docDailyHoursRaw !== '') {
      if (c.shift && c.filedHours < c.dailyHours) {
        items.push({
          no: 4, title: '1일 소정근로시간', status: 'warn',
          actual: c.filedHours + '시간', expected: c.dailyHours + '시간(단축 전)',
          message: '단축 후 시간으로 적혀 있어요. 이 시간이 최저기초일액(하한)을 낮추는 기준이 되므로, 단축 전 시간으로 볼 여지가 있는지 관할 고용센터에 확인해 보세요.'
        });
      } else {
        items.push({
          no: 4, title: '1일 소정근로시간', status: 'ok',
          actual: c.filedHours + '시간', expected: c.dailyHours + '시간',
          message: '적힌 시간이 단축 전 소정근로시간과 같거나 커서, 이 항목으로 하한이 낮아지지는 않아요.'
        });
      }
    } else {
      items.push({
        no: 4, title: '1일 소정근로시간', status: 'unknown',
        actual: '이직확인서 사본에서 확인해 주세요',
        expected: (c.shift ? c.dailyHours + '시간(단축 전) / 단축 후 ' : '') + c.filedHours + '시간',
        message: '이 시간이 최저기초일액(하한)을 정하는 기준이에요. 단축근무 뒤라면 단축 후 시간으로 적혀 있는지 확인하세요.'
      });
    }

    var riskCount = items.filter(function (i) { return i.status === 'risk'; }).length;
    var warnCount = items.filter(function (i) { return i.status === 'warn'; }).length;

    return { items: items, riskCount: riskCount, warnCount: warnCount };
  }

  /* ───────── 카드 조립 ───────── */
  function buildCards(rows, shiftData, ctx) {
    var order = ['annual', 'leave', 'shift', 'extra', 'unemp'];
    return order.map(function (id) {
      var meta = CARD_META[id];
      var cardRows = rows.filter(function (r) { return r.group === id; });
      return {
        id: id, no: meta.no, title: meta.title, law: meta.law, body: meta.body, more: meta.more,
        rows: cardRows,
        compare: compareFor(id, shiftData, ctx),
        extra: extraNote(id, shiftData, ctx)
      };
    });
  }

  function compareFor(id, shiftData, ctx) {
    if (id !== 'unemp') return null;
    var a = {
      tag: '①', label: '이직확인서에 적힌 대로 (1일 ' + ctx.filedHours + '시간)',
      value: won(ctx.dFiled),
      sub: '기초일액 ' + won(ctx.baseFiled) + ' · 하한 ' + won(Math.round(ctx.floorFiled))
    };
    if (ctx.filedHours === ctx.dailyHours) return [a];
    var b = {
      tag: '②', label: '단축 전 소정근로시간 기준 (1일 ' + ctx.dailyHours + '시간)',
      value: won(ctx.dPre),
      sub: '기초일액 ' + won(ctx.basePre) + ' · 하한 ' + won(Math.round(ctx.floorPre))
    };
    return [a, b];
  }

  function extraNote(id, shiftData, ctx) {
    if (id === 'unemp') {
      var perDay = ctx.dPre - ctx.dFiled;
      return '적용 기준: ' + ctx.yearLabel + ' 이직자 · 상한 ' + won(ctx.uiDailyMax) + ' / 하한 ' +
        won(ctx.floor8) + '(1일 8시간) · 최저임금 ' + comma(ctx.minWage) + '원' +
        (perDay > 0 ? ' · 두 기준의 차이는 하루 ' + won(perDay) + ', ' + ctx.benefitDays + '일이면 ' + won(perDay * ctx.benefitDays) : '');
    }
    if (id === 'shift' && shiftData) {
      return '단축 전 기준 1일 평균임금 ' + won(ctx.lawfulDaily) + ' / 단축 급여 기준 ' + won(Math.round(shiftData.companyDaily)) +
        ' · 단축 후 주 소정근로시간 ' + shiftData.weeklyHours + '시간' + (shiftData.holidayHours > 0 ? '(주휴 ' + shiftData.holidayHours + '시간 포함)' : '');
    }
    if (id === 'leave') {
      return '정당한 퇴직금 추정 ' + won(ctx.lawfulDaily) + ' × 30일 × ' + ctx.serviceDays + '일 ÷ 365일';
    }
    return '';
  }

  /* ───────── 카드 HTML ───────── */
  function cardHtml(card) {
    var sum = card.rows.reduce(function (s, r) { return s + (r.applicable && r.checked ? r.amount : 0); }, 0);
    var rowsHtml = card.rows.map(function (r) {
      return '<li class="row' + (r.applicable ? '' : ' na') + '" data-row="' + r.id + '">' +
        '<label class="row-main">' +
        (r.applicable ? '<input type="checkbox" class="row-toggle" data-row="' + r.id + '"' + (r.checked ? ' checked' : '') + '>' : '') +
        '<span class="row-title">' + r.title + '</span>' +
        '<span class="row-amount">' + (r.applicable ? won(r.amount) : '해당 없음') + '</span>' +
        '</label>' +
        '<p class="row-detail">' + r.detail + '</p>' +
        '</li>';
    }).join('');

    var compareHtml = '';
    if (card.compare && card.compare.length) {
      compareHtml = '<div class="compare' + (card.compare.length === 1 ? ' single' : '') + '">' +
        card.compare.map(function (c) {
          return '<div class="compare-item">' +
            '<span class="compare-tag">' + c.tag + '</span>' +
            '<span class="compare-label">' + c.label + '</span>' +
            '<strong class="compare-value">' + c.value + '</strong>' +
            '<span class="compare-sub">' + c.sub + '</span>' +
            '</div>';
        }).join('') + '</div>';
    }

    return '<article class="card" id="card-' + card.id + '">' +
      '<div class="card-head">' +
      '<span class="card-no">' + card.no + '</span>' +
      '<h3 class="card-title">' + card.title + '</h3>' +
      '<span class="card-sum' + (sum === 0 ? ' zero' : '') + '" data-card-sum="' + card.id + '">' + (sum === 0 ? '0원' : won(sum)) + '</span>' +
      '</div>' +
      '<p class="card-body">' + card.body + '</p>' +
      compareHtml +
      '<ul class="rows">' + rowsHtml + '</ul>' +
      (card.extra ? '<p class="card-extra">' + card.extra + '</p>' : '') +
      '<span class="law">' + card.law + '</span>' +
      '<details class="card-more"><summary>왜 이렇게 계산되나요?</summary><p class="more-body">' + card.more + '</p></details>' +
      '</article>';
  }

  var DOC_STATUS_TEXT = { ok: '일치', warn: '확인 필요', risk: '정정 필요', unknown: '직접 확인' };

  function docItemHtml(it) {
    return '<li class="check-row is-' + it.status + '">' +
      '<div class="check-head">' +
      '<span class="check-no">' + it.no + '</span>' +
      '<span class="check-title">' + it.title + '</span>' +
      '<span class="badge ' + it.status + '">' + DOC_STATUS_TEXT[it.status] + '</span>' +
      '</div>' +
      '<div class="check-vals">' +
      '<span><b>이직확인서</b> ' + it.actual + '</span>' +
      '<span><b>확인 기준</b> ' + it.expected + '</span>' +
      '</div>' +
      '<p class="check-msg">' + it.message + '</p>' +
      '</li>';
  }

  /* ───────── 브라우저 UI ───────── */
  function init() {
    var form = document.getElementById('calc-form');
    if (!form) return;

    var resultPanel = document.getElementById('result-panel');
    var cardsEl = document.getElementById('cards');
    var warningsEl = document.getElementById('warnings');
    var summaryEl = document.getElementById('summary-line');
    var errorEl = document.getElementById('form-error');
    var totalAmountEl = document.getElementById('total-amount');
    var totalSubEl = document.getElementById('total-sub');
    var totalListEl = document.getElementById('total-list');
    var basisEl = document.getElementById('basis-line');
    var docPanel = document.getElementById('doc-check');
    var docItemsEl = document.getElementById('doc-items');
    var docVerdictEl = document.getElementById('doc-verdict');
    var lastResult = null;

    function bindMoney(el) {
      if (!el) return;
      el.addEventListener('input', function () {
        var digits = el.value.replace(/[^0-9]/g, '');
        if (digits !== el.value) el.value = digits;
      });
      el.addEventListener('blur', function () {
        var n = toNum(el.value);
        el.value = n > 0 ? comma(n) : '';
      });
    }
    ['monthlyPay', 'threeMonthTotal', 'shiftPay', 'extraPaid', 'uiReportedPay', 'annualDays', 'annualUsed',
     'uiBenefitDays', 'dailyHours', 'weekDays', 'shiftHours', 'shiftWeekDays', 'extraHours', 'uiAge',
     'docDailyHours', 'docInsuredDays', 'docAvgDaily']
      .forEach(function (id) { bindMoney(document.getElementById(id)); });

    /* 연차 자동 계산 */
    var annualInput = document.getElementById('annualDays');
    var annualHint = document.getElementById('annual-hint');
    var annualEdited = false;
    annualInput.addEventListener('input', function () { annualEdited = !(annualInput.value.trim() === ''); });

    function refreshAnnualAuto() {
      var hire = parseDate(document.getElementById('hireDate').value);
      var quit = parseDate(document.getElementById('quitDate').value);
      if (!hire || !quit || diffDays(hire, quit) <= 0) return;
      var auto = annualLeave(hire, quit);
      if (!annualEdited) annualInput.value = String(auto.days);
      annualHint.textContent = auto.label + ' 자동 계산 · 직접 고쳐도 됩니다.';
    }
    document.getElementById('hireDate').addEventListener('change', refreshAnnualAuto);
    document.getElementById('quitDate').addEventListener('change', refreshAnnualAuto);

    /* 소정급여일수 자동 */
    function refreshBenefitDays() {
      var age = toNum(document.getElementById('uiAge').value);
      var group = document.getElementById('uiInsured').value;
      if (!age || group === '') return;
      var d = benefitDaysFor(age, group);
      document.getElementById('uiBenefitDays').value = String(d);
      var hint = document.getElementById('ui-days-hint');
      if (hint) hint.textContent = (age >= 50 ? '만 50세 이상' : '만 50세 미만') + ' · 가입기간 기준 자동 계산(직접 고쳐도 됩니다)';
    }
    document.getElementById('uiAge').addEventListener('blur', refreshBenefitDays);
    document.getElementById('uiInsured').addEventListener('change', refreshBenefitDays);

    /* 육아휴직 기간 추가 */
    var leaveList = document.getElementById('leave-list');
    var addLeaveBtn = document.getElementById('add-leave');
    function leaveRowHtml(idx) {
      return '<div class="period-row" data-index="' + idx + '">' +
        '<div class="grid2">' +
        '<label class="field"><span class="label">시작일</span><input type="date" id="leaveStart-' + idx + '" class="leave-start"></label>' +
        '<label class="field"><span class="label">종료일</span><input type="date" id="leaveEnd-' + idx + '" class="leave-end"></label>' +
        '</div><p class="period-note" data-role="leave-length"></p></div>';
    }
    if (addLeaveBtn) {
      addLeaveBtn.addEventListener('click', function () {
        var idx = leaveList.querySelectorAll('.period-row').length;
        if (idx >= 3) { addLeaveBtn.disabled = true; addLeaveBtn.textContent = '기간은 최대 3개까지'; return; }
        leaveList.insertAdjacentHTML('beforeend', leaveRowHtml(idx));
        if (idx + 1 >= 3) { addLeaveBtn.disabled = true; addLeaveBtn.textContent = '기간은 최대 3개까지'; }
      });
    }

    leaveList.addEventListener('change', function (e) {
      var row = e.target.closest('.period-row');
      if (!row) return;
      var note = row.querySelector('[data-role="leave-length"]');
      var s = parseDate(row.querySelector('.leave-start').value);
      var en = parseDate(row.querySelector('.leave-end').value);
      if (s && en && en >= s) note.textContent = diffDays(s, en) + 1 + '일';
      else note.textContent = '';
    });

    function collect() {
      var leaves = [];
      leaveList.querySelectorAll('.period-row').forEach(function (row) {
        leaves.push({
          start: row.querySelector('.leave-start').value,
          end: row.querySelector('.leave-end').value
        });
      });
      function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
      return {
        hireDate: val('hireDate'), quitDate: val('quitDate'),
        monthlyPay: val('monthlyPay'), dailyHours: val('dailyHours'), weekDays: val('weekDays'),
        pensionType: val('pensionType'), threeMonthTotal: val('threeMonthTotal'),
        leaves: leaves,
        shiftStart: val('shiftStart'), shiftEnd: val('shiftEnd'),
        shiftHours: val('shiftHours'), shiftWeekDays: val('shiftWeekDays'), shiftPay: val('shiftPay'),
        extraHours: val('extraHours'), extraPaid: val('extraPaid'),
        annualDays: val('annualDays'), annualUsed: val('annualUsed'),
        uiAge: val('uiAge'), uiInsured: val('uiInsured'),
        uiBenefitDays: val('uiBenefitDays'), uiReportedPay: val('uiReportedPay'),
        docReason: val('docReason'), myReason: val('myReason'),
        docInsuredDays: val('docInsuredDays'), docAvgDaily: val('docAvgDaily'), docDailyHours: val('docDailyHours')
      };
    }

    function clearErrors() {
      errorEl.hidden = true;
      errorEl.textContent = '';
      form.querySelectorAll('.invalid').forEach(function (el) { el.classList.remove('invalid'); });
    }

    function fieldElement(field) {
      if (!field) return null;
      if (field.indexOf('leave-') === 0) return document.getElementById('leaveStart-' + field.split('-')[1]);
      return document.getElementById(field);
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearErrors();
      var res = compute(collect());
      if (!res.ok) {
        var first = res.errors[0];
        errorEl.textContent = res.errors.length > 1
          ? first.message + ' (외 ' + (res.errors.length - 1) + '건)'
          : first.message;
        errorEl.hidden = false;
        var el = fieldElement(first.field);
        if (el) {
          el.classList.add('invalid');
          el.focus();
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        return;
      }
      render(res);
    });

    function render(res) {
      lastResult = res;

      warningsEl.innerHTML = res.warnings.map(function (w) {
        return '<p class="warn ' + (w.type === 'info' ? 'info' : '') + '">' + w.text + '</p>';
      }).join('');
      warningsEl.hidden = res.warnings.length === 0;

      summaryEl.textContent = res.summary;

      if (basisEl) {
        basisEl.innerHTML = '적용 기준: 이직일 ' + res.meta.basisLabel + ' · 구직급여 상한 ' +
          comma(res.meta.dailyMax) + '원 / 하한 ' + comma(res.meta.dailyMin) +
          '원(1일 8시간) · 평균임금 산정기간 ' + fmtDate(res.meta.windowStart) + '~' + fmtDate(res.meta.windowEnd) +
          '(' + res.meta.windowDays + '일)';
      }

      cardsEl.innerHTML = res.cards.map(cardHtml).join('');

      cardsEl.querySelectorAll('.row-toggle').forEach(function (input) {
        input.addEventListener('change', function () {
          var row = input.closest('.row');
          var r = lastResult.rows.filter(function (x) { return x.id === input.dataset.row; })[0];
          if (r) r.checked = input.checked;
          row.classList.toggle('off', !input.checked);
          refreshSums();
        });
      });

      renderDocCheck(res.docCheck);

      resultPanel.hidden = false;
      refreshSums();
      var title = document.getElementById('result-title');
      if (title) title.focus({ preventScroll: true });
      resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderDocCheck(check) {
      if (!check || !docItemsEl) return;
      docItemsEl.innerHTML = check.items.map(docItemHtml).join('');

      if (docVerdictEl) {
        var msg;
        if (check.riskCount > 0) {
          msg = '정정이 필요해 보이는 칸이 ' + check.riskCount + '개 있어요. 아래 순서대로 회사와 기관에 확인해 보세요.';
        } else if (check.warnCount > 0) {
          msg = '차이가 있는 칸이 ' + check.warnCount + '개 있어요. 금액이 크게 달라질 수 있으니 근거 자료를 챙겨 확인해 보세요.';
        } else if (check.items.every(function (i) { return i.status === 'unknown'; })) {
          msg = '이직확인서 사본을 받아 네 칸을 직접 확인해 보세요. 위 입력란에 값을 넣으면 자동으로 비교해 드려요.';
        } else {
          msg = '입력한 범위에서는 이직확인서에 문제가 될 만한 차이를 찾지 못했어요. 다만 이 점검은 입력값에 기반한 참고용입니다.';
        }
        docVerdictEl.textContent = msg;
      }
      if (docPanel) docPanel.hidden = false;
    }

    function refreshSums() {
      if (!lastResult) return;
      var total = 0, included = 0, applicableCount = 0;
      lastResult.rows.forEach(function (r) {
        if (r.applicable) applicableCount++;
        if (r.applicable && r.checked) { total += r.amount; included++; }
      });
      totalAmountEl.textContent = won(total);
      totalSubEl.textContent = applicableCount + '개 항목 중 ' + included + '개 포함';
      totalListEl.innerHTML = lastResult.rows.filter(function (r) { return r.applicable && r.checked; })
        .map(function (r) {
          return '<li><span>' + r.title + '</span><span>' + won(r.amount) + '</span></li>';
        }).join('') || '<li><span>포함된 항목이 없어요</span><span>0원</span></li>';

      lastResult.cards.forEach(function (card) {
        var el = document.querySelector('[data-card-sum="' + card.id + '"]');
        if (!el) return;
        var sum = card.rows.reduce(function (s, r) { return s + (r.applicable && r.checked ? r.amount : 0); }, 0);
        el.textContent = sum === 0 ? '0원' : won(sum);
        el.classList.toggle('zero', sum === 0);
      });
    }

    /* 결과 복사 */
    var copyBtn = document.getElementById('copy-result');
    var copyStatus = document.getElementById('copy-status');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (!lastResult) return;
        var lines = ['[육아휴직·단축근무 정산 자가 점검 메모]'];
        lastResult.rows.forEach(function (r) {
          if (r.applicable) lines.push('· ' + r.title + ': ' + won(r.amount) + (r.checked ? '' : ' (미포함)'));
        });
        var total = lastResult.rows.reduce(function (s, r) { return s + (r.applicable && r.checked ? r.amount : 0); }, 0);
        lines.push('합계(최대 추정): ' + won(total));
        lines.push('평균임금 산정기간: ' + fmtDate(lastResult.meta.windowStart) + '~' + fmtDate(lastResult.meta.windowEnd) + ' (' + lastResult.meta.windowDays + '일)');
        lines.push('※ 참고용 추정치입니다. 실제 산정·청구는 고용노동부 1350 또는 관할 고용센터·공인노무사에게 확인하세요.');
        lines.push('기준: ' + RULES.basis + ' · ' + lastResult.summary);
        var text = lines.join('\n');

        function done() { copyStatus.textContent = '복사했어요. 메모장이나 문자에 붙여 넣어 보세요.'; }
        function fallback() {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); done(); } catch (err) { copyStatus.textContent = '복사가 막혀 있어요. 화면을 길게 눌러 직접 복사해 주세요.'; }
          document.body.removeChild(ta);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else {
          fallback();
        }
      });
    }

    var printBtn = document.getElementById('print-result');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

    /* 예시 값 */
    var fillBtn = document.getElementById('fill-example');
    if (fillBtn) {
      fillBtn.addEventListener('click', function () {
        function set(id, v) { var el = document.getElementById(id); if (el) el.value = v; }
        set('hireDate', '2019-03-04');
        set('quitDate', '2026-11-30');
        set('monthlyPay', '3,200,000');
        set('dailyHours', '8');
        set('weekDays', '5');
        set('pensionType', 'severance');
        set('leaveStart-0', '2023-01-02');
        set('leaveEnd-0', '2023-12-31');
        set('shiftStart', '2024-01-02');
        set('shiftEnd', '2026-09-30');
        set('shiftHours', '6');
        set('shiftWeekDays', '5');
        set('shiftPay', '2,400,000');
        set('extraHours', '40');
        set('extraPaid', '0');
        set('annualUsed', '5');
        set('uiAge', '34');
        set('uiInsured', '3');
        set('uiReportedPay', '2,400,000');
        set('docDailyHours', '6');
        set('docReason', '11');
        set('myReason', '23');
        set('docInsuredDays', '900');
        annualEdited = false;
        refreshAnnualAuto();
        refreshBenefitDays();
        form.requestSubmit();
      });
    }
  }

  /* 노출 */
  window.Calc = {
    RULES: RULES,
    parseDate: parseDate,
    diffDays: diffDays,
    addMonths: addMonths,
    annualLeave: annualLeave,
    wageBase: wageBase,
    fmtDate: fmtDate,
    weeklyHolidayHours: weeklyHolidayHours,
    benefitDaysFor: benefitDaysFor,
    averageWindow: averageWindow,
    insuredUnitsFor: insuredUnitsFor,
    compute: compute,
    cardHtml: cardHtml,
    docItemHtml: docItemHtml,
    toNum: toNum,
    won: won,
    comma: comma
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
