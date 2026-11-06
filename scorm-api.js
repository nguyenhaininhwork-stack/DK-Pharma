// Cài đặt SCORM Runtime API cho cả SCORM 1.2 (window.API) và SCORM 2004 (window.API_1484_11).
// Dữ liệu CMI được lưu trong localStorage theo từng gói + từng SCO.
(function () {
  const ERR12 = {
    0: 'No error', 101: 'General exception', 201: 'Invalid argument error',
    202: 'Element cannot have children', 203: 'Element not an array - cannot have count',
    301: 'Not initialized', 401: 'Not implemented error', 402: 'Invalid set value, element is a keyword',
    403: 'Element is read only', 404: 'Element is write only', 405: 'Incorrect data type',
  };
  const ERR2004 = {
    0: 'No error', 101: 'General exception', 102: 'General Initialization Failure',
    103: 'Already Initialized', 104: 'Content Instance Terminated', 111: 'General Termination Failure',
    112: 'Termination Before Initialization', 113: 'Termination After Termination',
    122: 'Retrieve Data Before Initialization', 123: 'Retrieve Data After Termination',
    132: 'Store Data Before Initialization', 133: 'Store Data After Termination',
    142: 'Commit Before Initialization', 143: 'Commit After Termination',
    201: 'General Argument Error', 301: 'General Get Failure', 351: 'General Set Failure',
    391: 'General Commit Failure', 401: 'Undefined Data Model Element',
    402: 'Unimplemented Data Model Element', 403: 'Data Model Element Value Not Initialized',
    404: 'Data Model Element Is Read Only', 405: 'Data Model Element Is Write Only',
    406: 'Data Model Element Type Mismatch', 407: 'Data Model Element Value Out Of Range',
    408: 'Data Model Dependency Not Established',
  };

  const RO12 = new Set(['cmi.core.student_id', 'cmi.core.student_name', 'cmi.core.credit', 'cmi.core.entry',
    'cmi.core.total_time', 'cmi.core.lesson_mode', 'cmi.launch_data', 'cmi.comments_from_lms',
    'cmi.student_data.mastery_score', 'cmi.student_data.max_time_allowed', 'cmi.student_data.time_limit_action']);
  const WO12 = new Set(['cmi.core.exit', 'cmi.core.session_time']);
  const RO2004 = new Set(['cmi.learner_id', 'cmi.learner_name', 'cmi.credit', 'cmi.entry', 'cmi.total_time',
    'cmi.mode', 'cmi.launch_data', 'cmi.completion_threshold', 'cmi.scaled_passing_score',
    'cmi.max_time_allowed', 'cmi.time_limit_action', 'cmi._version']);
  const WO2004 = new Set(['cmi.exit', 'cmi.session_time']);

  const CHILDREN12 = {
    'cmi.core._children': 'student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time',
    'cmi.core.score._children': 'raw,min,max',
    'cmi.objectives._children': 'id,score,status',
    'cmi.student_data._children': 'mastery_score,max_time_allowed,time_limit_action',
    'cmi.student_preference._children': 'audio,language,speed,text',
    'cmi.interactions._children': 'id,objectives,time,type,correct_responses,weighting,student_response,result,latency',
  };
  const CHILDREN2004 = {
    'cmi.score._children': 'scaled,raw,min,max',
    'cmi.objectives._children': 'id,score,success_status,completion_status,progress_measure,description',
    'cmi.interactions._children': 'id,type,objectives,timestamp,correct_responses,weighting,learner_response,result,latency,description',
    'cmi.learner_preference._children': 'audio_level,language,delivery_speed,audio_captioning',
    'cmi.comments_from_learner._children': 'comment,location,timestamp',
    'cmi.comments_from_lms._children': 'comment,location,timestamp',
  };

  // ---- Thời gian ----
  function parse12Time(t) { // HHHH:MM:SS.SS -> giây
    const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(t || '');
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
  }
  function fmt12Time(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return String(h).padStart(4, '0') + ':' + String(m).padStart(2, '0') + ':' + sec.toFixed(2).padStart(5, '0');
  }
  function parseISODur(d) { // PnYnMnDTnHnMnS -> giây
    const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d || '');
    if (!m) return 0;
    const n = (i) => +(m[i] || 0);
    return n(1) * 31536000 + n(2) * 2592000 + n(3) * 86400 + n(4) * 3600 + n(5) * 60 + n(6);
  }
  function fmtISODur(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = +(s % 60).toFixed(2);
    return 'PT' + h + 'H' + m + 'M' + sec + 'S';
  }

  class ScormRuntime {
    /**
     * @param {object} opts { storageKey, learnerName, learnerId, launchData, masteryScore, onLog, onChange }
     */
    constructor(opts) {
      this.opts = opts;
      this.key = opts.storageKey;
      this.data = this._load();
      this.state12 = 'not';   // not | running | done
      this.state2004 = 'not';
      this.err12 = 0; this.err2004 = 0;
      this.version = null;
      this.API = this._build12();
      this.API_1484_11 = this._build2004();
    }

    _load() {
      try { return JSON.parse(localStorage.getItem(this.key)) || {}; } catch (_) { return {}; }
    }
    _save() {
      try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch (_) { /* quota */ }
      this.opts.onChange && this.opts.onChange(this.summary());
    }
    _log(api, fn, args, ret, err) {
      this.opts.onLog && this.opts.onLog({ api, fn, args, ret, err });
    }

    summary() {
      const d = this.data;
      if (this.version === '2004') {
        return {
          'Phiên bản': 'SCORM 2004',
          'Hoàn thành': d['cmi.completion_status'] || 'unknown',
          'Kết quả': d['cmi.success_status'] || 'unknown',
          'Điểm': d['cmi.score.raw'] != null ? d['cmi.score.raw'] + (d['cmi.score.max'] ? '/' + d['cmi.score.max'] : '') : (d['cmi.score.scaled'] != null ? Math.round(d['cmi.score.scaled'] * 100) + '%' : '—'),
          'Vị trí': d['cmi.location'] || '—',
          'Tổng thời gian': d['cmi.total_time'] || 'PT0S',
        };
      }
      return {
        'Phiên bản': this.version === '1.2' ? 'SCORM 1.2' : '—',
        'Trạng thái': d['cmi.core.lesson_status'] || 'not attempted',
        'Điểm': d['cmi.core.score.raw'] ? d['cmi.core.score.raw'] + (d['cmi.core.score.max'] ? '/' + d['cmi.core.score.max'] : '') : '—',
        'Vị trí': d['cmi.core.lesson_location'] || '—',
        'Tổng thời gian': d['cmi.core.total_time'] || '0000:00:00',
      };
    }

    // Trạng thái đơn giản dùng cho mục lục: 'completed' | 'passed' | 'failed' | 'incomplete' | ''
    status() {
      const d = this.data;
      const s = d['cmi.core.lesson_status'];
      if (s && s !== 'not attempted') return s === 'browsed' ? 'incomplete' : s;
      if (d['cmi.success_status'] === 'passed' || d['cmi.success_status'] === 'failed') return d['cmi.success_status'];
      if (d['cmi.completion_status'] === 'completed') return 'completed';
      if (d['cmi.completion_status'] === 'incomplete') return 'incomplete';
      return '';
    }

    _count(prefix) {
      let max = -1;
      const re = new RegExp('^' + prefix.replace(/\./g, '\\.') + '\\.(\\d+)\\.');
      for (const k in this.data) { const m = re.exec(k); if (m) max = Math.max(max, +m[1]); }
      return max + 1;
    }

    // ================= SCORM 1.2 =================
    _init12Defaults() {
      const d = this.data, o = this.opts;
      const had = !!d['cmi.core.lesson_status'] && d['cmi.core.lesson_status'] !== 'not attempted';
      d['cmi.core.student_id'] = o.learnerId;
      d['cmi.core.student_name'] = o.learnerName;
      d['cmi.core.credit'] = 'credit';
      d['cmi.core.lesson_mode'] = 'normal';
      d['cmi.core.lesson_status'] = d['cmi.core.lesson_status'] || 'not attempted';
      d['cmi.core.total_time'] = d['cmi.core.total_time'] || '0000:00:00';
      d['cmi.core.entry'] = d['cmi.core.exit'] === 'suspend' || had ? 'resume' : 'ab-initio';
      d['cmi.launch_data'] = o.launchData || '';
      if (o.masteryScore != null) d['cmi.student_data.mastery_score'] = String(o.masteryScore);
      delete d['cmi.core.exit']; delete d['cmi.core.session_time'];
    }

    _get12(el) {
      if (CHILDREN12[el]) return CHILDREN12[el];
      const cm = /^(cmi\.(?:objectives|interactions)(?:\.\d+\.(?:objectives|correct_responses))?)\._count$/.exec(el);
      if (cm) return String(this._count(cm[1]));
      if (WO12.has(el)) { this.err12 = 404; return ''; }
      if (!/^cmi\./.test(el)) { this.err12 = 201; return ''; }
      const v = this.data[el];
      return v == null ? '' : String(v);
    }

    _set12(el, val) {
      if (/\._(children|count)$/.test(el)) { this.err12 = 402; return 'false'; }
      if (RO12.has(el)) { this.err12 = 403; return 'false'; }
      if (!/^cmi\./.test(el)) { this.err12 = 201; return 'false'; }
      this.data[el] = String(val);
      // tự chấm đạt/không đạt nếu có mastery score
      if (el === 'cmi.core.score.raw' && this.data['cmi.student_data.mastery_score'] && val !== '') {
        const st = this.data['cmi.core.lesson_status'];
        if (st === 'completed' || st === 'incomplete' || st === 'not attempted' || !st) {
          this.data['cmi.core.lesson_status'] = (+val >= +this.data['cmi.student_data.mastery_score']) ? 'passed' : 'failed';
        }
      }
      return 'true';
    }

    _finish12() {
      const d = this.data;
      const st = parse12Time(d['cmi.core.session_time']);
      d['cmi.core.total_time'] = fmt12Time(parse12Time(d['cmi.core.total_time']) + st);
      if (d['cmi.core.lesson_status'] === 'not attempted') d['cmi.core.lesson_status'] = 'incomplete';
      if (d['cmi.core.exit'] !== 'suspend') { /* vẫn giữ dữ liệu để xem lại */ }
      delete d['cmi.core.session_time'];
    }

    _build12() {
      const self = this;
      const wrap = (fn, impl) => function (...args) {
        let ret;
        try { ret = impl(...args.map((a) => (a == null ? '' : String(a)))); } catch (e) { self.err12 = 101; ret = 'false'; }
        self._log('1.2', fn, args, ret, self.err12);
        return ret;
      };
      return {
        LMSInitialize: wrap('LMSInitialize', () => {
          self.err12 = 0;
          if (self.state12 === 'running') { self.err12 = 101; return 'false'; }
          self.version = self.version || '1.2';
          self._init12Defaults(); self.state12 = 'running'; self._save();
          return 'true';
        }),
        LMSFinish: wrap('LMSFinish', () => {
          self.err12 = 0;
          if (self.state12 !== 'running') { self.err12 = 301; return 'false'; }
          self._finish12(); self.state12 = 'done'; self._save();
          return 'true';
        }),
        LMSGetValue: wrap('LMSGetValue', (el) => {
          self.err12 = 0;
          if (self.state12 !== 'running') { self.err12 = 301; return ''; }
          return self._get12(el);
        }),
        LMSSetValue: wrap('LMSSetValue', (el, val) => {
          self.err12 = 0;
          if (self.state12 !== 'running') { self.err12 = 301; return 'false'; }
          const r = self._set12(el, val);
          if (r === 'true') self.opts.onChange && self.opts.onChange(self.summary());
          return r;
        }),
        LMSCommit: wrap('LMSCommit', () => {
          self.err12 = 0;
          if (self.state12 !== 'running') { self.err12 = 301; return 'false'; }
          self._save(); return 'true';
        }),
        LMSGetLastError: () => String(self.err12),
        LMSGetErrorString: (c) => ERR12[+c] || '',
        LMSGetDiagnostic: (c) => ERR12[c === '' || c == null ? self.err12 : +c] || '',
      };
    }

    // ================= SCORM 2004 =================
    _init2004Defaults() {
      const d = this.data, o = this.opts;
      const had = d['cmi.completion_status'] && d['cmi.completion_status'] !== 'not attempted' && d['cmi.completion_status'] !== 'unknown';
      d['cmi._version'] = '1.0';
      d['cmi.learner_id'] = o.learnerId;
      d['cmi.learner_name'] = o.learnerName;
      d['cmi.credit'] = 'credit';
      d['cmi.mode'] = 'normal';
      d['cmi.completion_status'] = d['cmi.completion_status'] || 'unknown';
      d['cmi.success_status'] = d['cmi.success_status'] || 'unknown';
      d['cmi.total_time'] = d['cmi.total_time'] || 'PT0H0M0S';
      d['cmi.entry'] = d['cmi.exit'] === 'suspend' || had ? 'resume' : 'ab-initio';
      d['cmi.launch_data'] = o.launchData || '';
      if (o.masteryScore != null) d['cmi.scaled_passing_score'] = String(o.masteryScore);
      delete d['cmi.exit']; delete d['cmi.session_time'];
    }

    _get2004(el) {
      if (el === '') { this.err2004 = 301; return ''; }
      if (CHILDREN2004[el]) return CHILDREN2004[el];
      const cm = /^(cmi\.(?:objectives|interactions|comments_from_learner|comments_from_lms)(?:\.\d+\.(?:objectives|correct_responses))?)\._count$/.exec(el);
      if (cm) return String(this._count(cm[1]));
      if (WO2004.has(el)) { this.err2004 = 405; return ''; }
      if (/^adl\.nav\./.test(el)) {
        if (el === 'adl.nav.request') return this.data[el] || '_none_';
        if (/^adl\.nav\.request_valid\./.test(el)) return 'unknown';
        return '';
      }
      if (!/^cmi\./.test(el)) { this.err2004 = 401; return ''; }
      const v = this.data[el];
      if (v == null) { this.err2004 = 403; return ''; }
      return String(v);
    }

    _set2004(el, val) {
      if (el === '') { this.err2004 = 351; return 'false'; }
      if (/\._(children|count|version)$/.test(el)) { this.err2004 = 404; return 'false'; }
      if (RO2004.has(el)) { this.err2004 = 404; return 'false'; }
      if (el === 'adl.nav.request') {
        this.data[el] = val;
        this.opts.onNavRequest && this.opts.onNavRequest(val);
        return 'true';
      }
      if (!/^cmi\./.test(el)) { this.err2004 = 401; return 'false'; }
      this.data[el] = String(val);
      return 'true';
    }

    _terminate2004() {
      const d = this.data;
      d['cmi.total_time'] = fmtISODur(parseISODur(d['cmi.total_time']) + parseISODur(d['cmi.session_time']));
      // chấm đạt theo scaled_passing_score nếu SCO không tự đặt
      if (d['cmi.scaled_passing_score'] != null && d['cmi.score.scaled'] != null && (d['cmi.success_status'] || 'unknown') === 'unknown') {
        d['cmi.success_status'] = +d['cmi.score.scaled'] >= +d['cmi.scaled_passing_score'] ? 'passed' : 'failed';
      }
      delete d['cmi.session_time'];
    }

    _build2004() {
      const self = this;
      const wrap = (fn, impl) => function (...args) {
        let ret;
        try { ret = impl(...args.map((a) => (a == null ? '' : String(a)))); } catch (e) { self.err2004 = 101; ret = 'false'; }
        self._log('2004', fn, args, ret, self.err2004);
        return ret;
      };
      return {
        Initialize: wrap('Initialize', () => {
          self.err2004 = 0;
          if (self.state2004 === 'running') { self.err2004 = 103; return 'false'; }
          if (self.state2004 === 'done') { self.err2004 = 104; return 'false'; }
          self.version = '2004';
          self._init2004Defaults(); self.state2004 = 'running'; self._save();
          return 'true';
        }),
        Terminate: wrap('Terminate', () => {
          self.err2004 = 0;
          if (self.state2004 === 'not') { self.err2004 = 112; return 'false'; }
          if (self.state2004 === 'done') { self.err2004 = 113; return 'false'; }
          self._terminate2004(); self.state2004 = 'done'; self._save();
          const nav = self.data['adl.nav.request'];
          if (nav && nav !== '_none_') {
            delete self.data['adl.nav.request'];
            self._save();
            setTimeout(() => self.opts.onNavRequest && self.opts.onNavRequest(nav, true), 0);
          }
          return 'true';
        }),
        GetValue: wrap('GetValue', (el) => {
          self.err2004 = 0;
          if (self.state2004 === 'not') { self.err2004 = 122; return ''; }
          if (self.state2004 === 'done') { self.err2004 = 123; return ''; }
          return self._get2004(el);
        }),
        SetValue: wrap('SetValue', (el, val) => {
          self.err2004 = 0;
          if (self.state2004 === 'not') { self.err2004 = 132; return 'false'; }
          if (self.state2004 === 'done') { self.err2004 = 133; return 'false'; }
          const r = self._set2004(el, val);
          if (r === 'true') self.opts.onChange && self.opts.onChange(self.summary());
          return r;
        }),
        Commit: wrap('Commit', () => {
          self.err2004 = 0;
          if (self.state2004 === 'not') { self.err2004 = 142; return 'false'; }
          if (self.state2004 === 'done') { self.err2004 = 143; return 'false'; }
          self._save(); return 'true';
        }),
        GetLastError: () => String(self.err2004),
        GetErrorString: (c) => ERR2004[+c] || '',
        GetDiagnostic: (c) => ERR2004[c === '' || c == null ? self.err2004 : +c] || '',
      };
    }
  }

  window.ScormRuntime = ScormRuntime;
})();
