window.__ModuleLoader__.load({
  id: 'dsh-game-daily',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const NS = 'gameDaily.settings';

    const dictionaries = {
      zh: {
        nav: '游戏日常',
        title: '游戏日常',
        subtitle: '为每个游戏设定每日自动执行时间，到点自动跑日常，跑完向你汇报。',
        heroOn: '代理日常',
        heroOff: '代理日常',
        offHint: '默认关闭。打开后才会出现排班与执行设置；所有改动点「保存并应用」才生效。',
        enable: '开启代理',
        enabled: '已开启',
        disabled: '已关闭',
        tabPaused: '暂停',
        sectionSchedule: '排班',
        sectionRun: '执行',
        sectionDeps: '依赖体检',
        sectionRuns: '最近运行',
        mode: '模式',
        modeReal: '真实执行',
        modeDry: '演练（只看不点）',
        time: '每天时间',
        weekdays: '执行日',
        weekdaysDaily: '每天',
        weekdaysCustom: '指定星期',
        catchUp: '错过补跑（开机后补一次）',
        foregroundGuard: '前台守护（游戏被抢走时自动拉回）',
        autoExitNote: '真实模式：本轮结束后自动关闭游戏；下一款开始前会先确保上一款已经退出。',
        timeout: '超时（分钟）',
        gamePath: '游戏路径（可选）',
        saveApply: '保存并应用',
        saving: '正在应用…',
        disable: '关闭全部代理',
        runNow: '立即运行一次',
        running: '运行中',
        stop: '停止',
        refreshProbe: '重新体检',
        probeLoading: '体检中…',
        nextRun: '下次运行',
        taskState: '任务状态',
        noTask: '尚未创建计划任务',
        lastRun: '最近一次',
        noRuns: '还没有运行记录',
        viewReport: '查看报告',
        close: '关闭',
        fix: '让 DSH 修这个',
        fixing: '处理中…',
        fixed: '已打开修复会话，回到这里点「重新体检」。',
        bettergiMcpDownloaded: 'bettergi-mcp 就绪（插件自带，未联网）。',
        skillInstalled: 'bettergi-control 技能已安装（插件自带，未联网）。',
        mcpRegistered: 'bettergi MCP 已写入当前 profile，重启 DSH 后生效。',
        installingZzz: '正在下载并安装一条龙（首次要下源码 + Python 依赖，可能几分钟，请别关页面）…',
        zzzInstalled: '一条龙已安装。下一步：点「启动一条龙后端」。',
        zzzServerStarting: '正在启动一条龙后端，弹 UAC 时请点允许…',
        applied: '已保存并提交注册；弹 UAC 时请点允许。',
        saved: '已保存',
        dirty: '有改动，待应用',
        pausedNote: '绝区零的键鼠注入被 ACE 拦截，本插件只保留占位，暂不提供自动代理。',
        statusOk: '就绪',
        statusWarn: '可用但有风险',
        statusMissing: '缺失',
        blocker: '阻断',
        reportTitle: '运行报告',
        loading: '加载中…',
        reportNone: '这一轮没有报告文件。',
        reportSession: '跑完后在「本游戏」固定的汇报会话里追加结果（不再每轮新建）',
        runHint: '立即运行使用已保存的设置；改完排班记得先「保存并应用」。',
        error: '出错了',
        taskRegistered: '计划任务已注册',
        taskMissing: '计划任务未注册',
        versionLabel: '版本',
        updateFound: '发现新版本',
        updateBody: '远程 v{latest} · 当前 v{current}',
        updateNow: '立即更新',
        updateLater: '稍后',
        updateNotes: '查看更新说明',
        updateChecking: '检查更新…',
        updateRunning: '正在更新…',
        updateDone: '已更新到 v{version}，重启 DSH 后生效',
        updateIsLatest: '已是最新版本',
        updateFailed: '检查更新失败',
        updateRestartHint: '更新完成后需要重启 DSH 桌面端才能加载新代码。',
      },
      en: {
        nav: 'Game Daily',
        title: 'Game Daily',
        subtitle: 'Schedule each game’s daily run; the run happens automatically and reports back.',
        heroOn: 'Game daily proxy',
        heroOff: 'Game daily proxy',
        offHint: 'Off by default. Turning it on reveals scheduling and execution settings; press Save & apply to commit.',
        enable: 'Enable proxy',
        enabled: 'Enabled',
        disabled: 'Disabled',
        tabPaused: 'Paused',
        sectionSchedule: 'Schedule',
        sectionRun: 'Execution',
        sectionDeps: 'Dependencies',
        sectionRuns: 'Recent runs',
        mode: 'Mode',
        modeReal: 'Real',
        modeDry: 'Dry run (no clicks)',
        time: 'Time',
        weekdays: 'Days',
        weekdaysDaily: 'Every day',
        weekdaysCustom: 'Selected days',
        catchUp: 'Catch up after boot',
        foregroundGuard: 'Foreground guard (pull the game back)',
        autoExitNote: 'Real mode: the game is closed after each run, and the previous game is closed before the next one starts.',
        timeout: 'Timeout (min)',
        gamePath: 'Game path (optional)',
        saveApply: 'Save & apply',
        saving: 'Applying…',
        disable: 'Disable all',
        runNow: 'Run now',
        running: 'Running',
        stop: 'Stop',
        refreshProbe: 'Re-check',
        probeLoading: 'Checking…',
        nextRun: 'Next run',
        taskState: 'Task state',
        noTask: 'No scheduled task yet',
        lastRun: 'Last run',
        noRuns: 'No runs yet',
        viewReport: 'View report',
        close: 'Close',
        fix: 'Let DSH fix it',
        fixing: 'Working…',
        fixed: 'Fix session opened. Come back and re-check.',
        bettergiMcpDownloaded: 'bettergi-mcp ready (bundled with the plugin, no network).',
        skillInstalled: 'bettergi-control skill installed (bundled, no network).',
        mcpRegistered: 'bettergi MCP written into the current profile; restart DSH to load it.',
        installingZzz: 'Installing OneDragon (source + Python deps, may take minutes — keep this page open)…',
        zzzInstalled: 'OneDragon installed. Next: start the backend.',
        zzzServerStarting: 'Starting the OneDragon backend; accept the UAC prompt if it appears…',
        applied: 'Saved and registration started; approve the UAC prompt if shown.',
        saved: 'Saved',
        dirty: 'Unsaved changes',
        pausedNote: 'Zenless Zone Zero blocks synthetic input (ACE). Placeholder only.',
        statusOk: 'Ready',
        statusWarn: 'Warnings',
        statusMissing: 'Missing',
        blocker: 'Blocker',
        reportTitle: 'Run report',
        loading: 'Loading…',
        reportNone: 'This run has no report file.',
        reportSession: 'Append each run to this game’s fixed report session (no new session per run)',
        runHint: 'Run now uses saved settings; press Save & apply after editing the schedule.',
        error: 'Error',
        taskRegistered: 'Task registered',
        taskMissing: 'Task missing',
        versionLabel: 'Version',
        updateFound: 'Update available',
        updateBody: 'Remote v{latest} · current v{current}',
        updateNow: 'Update now',
        updateLater: 'Later',
        updateNotes: 'Release notes',
        updateChecking: 'Checking…',
        updateRunning: 'Updating…',
        updateDone: 'Updated to v{version}. Restart DSH to load it.',
        updateIsLatest: 'You are on the latest version',
        updateFailed: 'Update check failed',
        updateRestartHint: 'Restart the DSH desktop app after updating to load the new code.',
      },
    };

    const CSS = [
      '.gd-wrap{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,inherit)}',
      '.gd-tabs{display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l2,#8883);padding-bottom:8px}',
      '.gd-tab{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,inherit);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px}',
      '.gd-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}',
      '.gd-tab[data-active="1"]{background:var(--dsw-alias-bg-overlay,#8882);border-color:var(--dsw-alias-border-l2,#8883);color:var(--dsw-alias-label-primary,inherit);font-weight:600}',
      '.gd-tab[data-disabled="1"]{opacity:.45;cursor:not-allowed}',
      '.gd-card{border:1px solid var(--dsw-alias-border-l2,#8883);border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-overlay,#8881);display:flex;flex-direction:column;gap:12px}',
      '.gd-hero{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.gd-hero h3{margin:0;font-size:15px}',
      '.gd-sub{color:var(--dsw-alias-label-tertiary,inherit);font-size:12.5px;line-height:1.5}',
      '.gd-switch{appearance:none;border:none;border-radius:999px;width:44px;height:24px;position:relative;cursor:pointer;background:#8885;transition:background .15s}',
      '.gd-switch[data-on="1"]{background:#3b82f6}',
      '.gd-switch::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s}',
      '.gd-switch[data-on="1"]::after{left:22px}',
      '.gd-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,#8884);background:var(--dsw-alias-bg-overlay,#8881);color:var(--dsw-alias-label-primary,inherit);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px}',
      '.gd-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}',
      '.gd-btn[data-primary="1"]{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}',
      '.gd-btn[disabled]{opacity:.5;cursor:not-allowed}',
      '.gd-btn[data-danger="1"]{color:#dc2626;border-color:#dc262655}',
      '.gd-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.gd-field{display:flex;flex-direction:column;gap:4px;min-width:120px}',
      '.gd-field label{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.gd-input,select.gd-input{background:transparent;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:8px;padding:6px 8px;color:inherit;font-size:13px;min-width:90px}',
      '.gd-day{appearance:none;border:1px solid var(--dsw-alias-border-l2,#8884);background:transparent;color:inherit;border-radius:6px;width:30px;height:28px;cursor:pointer;font-size:12px}',
      '.gd-day[data-on="1"]{background:#2563eb;border-color:#2563eb;color:#fff}',
      '.gd-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}',
      '.gd-badge{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#8884)}',
      '.gd-badge[data-tone="ok"]{color:#16a34a;border-color:#16a34a55}',
      '.gd-badge[data-tone="warn"]{color:#d97706;border-color:#d9770655}',
      '.gd-badge[data-tone="missing"]{color:#dc2626;border-color:#dc262655}',
      '.gd-check{border:1px solid var(--dsw-alias-border-l2,#8883);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
      '.gd-check-head{display:flex;align-items:center;gap:8px;justify-content:space-between}',
      '.gd-detail{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);white-space:pre-wrap;word-break:break-all;line-height:1.5}',
      '.gd-runs{display:flex;flex-direction:column;gap:6px}',
      '.gd-run{display:flex;gap:10px;align-items:center;justify-content:space-between;border-bottom:1px dashed var(--dsw-alias-border-l2,#8883);padding:6px 0;font-size:12.5px}',
      '.gd-modal{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;z-index:60;padding:24px}',
      '.gd-modal-body{background:var(--dsw-alias-bg-overlay,#1b1b1f);border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:12px;max-width:820px;width:100%;max-height:80vh;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}',
      '.gd-pre{margin:0;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:#0004;border-radius:8px;padding:10px;max-height:44vh;overflow:auto}',
      '.gd-note{font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}',
      '.gd-hint{font-size:12px;color:#d97706}',
      '.gd-section-title{font-size:13px;font-weight:600;margin:0 0 2px}',
      '.gd-empty{font-size:12.5px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.gd-update{border:1px solid var(--dsw-alias-border-l2,#8883);border-radius:10px;padding:10px 14px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-overlay,#8881)}',
      '.gd-update[data-tone="warn"]{border-color:#d9770666;background:#d9770612}',
      '.gd-update-head{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}',
      '.gd-update-title{font-size:13.5px;font-weight:600;margin:0}',
      '.gd-update-body{font-size:12px;margin:0;color:var(--dsw-alias-label-secondary,inherit)}',
      '.gd-update-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.gd-version{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.gd-link{appearance:none;border:0;background:none;padding:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer}',
    ].join('\n');

    const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
    const STATUS_ZH = { success: '成功', partial: '部分完成', failed: '失败', aborted: '中止', timeout: '超时', unknown: '未知' };
    const STATUS_TONE = { success: 'ok', partial: 'warn', failed: 'missing', aborted: 'warn', timeout: 'warn', unknown: 'warn' };

    async function api(path, options) {
      const response = await fetch(`/api/game-daily${path}`, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...options,
      });
      const text = await response.text();
      let value = {};
      try {
        value = text ? JSON.parse(text) : {};
      } catch {
        value = { ok: false, error: text.slice(0, 300) };
      }
      if (!response.ok || value.ok === false) {
        const error = new Error(value.error || (value.note ? String(value.note) : `HTTP ${response.status}`));
        error.payload = value;
        throw error;
      }
      return value;
    }

    function settingsDraftOf(state, gameId) {
      const game = state && Array.isArray(state.games) ? state.games.find((item) => item.id === gameId) : null;
      if (!game) {
        return { enabled: false, mode: 'real', schedule: { time: '10:00', weekdays: 'daily', catchUp: true }, timeoutMin: 90, gamePath: '' };
      }
      return {
        enabled: game.enabled,
        mode: game.mode,
        schedule: { ...game.schedule },
        timeoutMin: game.timeoutMin,
        gamePath: game.gamePath || '',
      };
    }

    function Badge({ tone, children }) {
      return h('span', { className: 'gd-badge', 'data-tone': tone }, children);
    }

    function Switch({ on, onChange, label, disabled }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label,
        className: 'gd-switch',
        'data-on': on ? '1' : '0',
        disabled: Boolean(disabled),
        onClick: () => onChange(!on),
      });
    }

    function ToggleRow({ label, hint, on, onChange, disabled }) {
      return h(
        'div',
        { className: 'gd-row', style: { justifyContent: 'space-between', width: '100%' } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', { style: { fontSize: '13px' } }, label),
          hint ? h('span', { className: 'gd-detail' }, hint) : null
        ),
        h(Switch, { on, onChange, label, disabled })
      );
    }

    function Section({ title, children, right }) {
      return h(
        'div',
        { className: 'gd-check' },
        h('div', { className: 'gd-check-head' }, h('p', { className: 'gd-section-title' }, title), right || null),
        children
      );
    }

    function ReportModal({ payload, onClose, t }) {
      if (!payload) return null;
      const report = payload.report;
      return h(
        'div',
        { className: 'gd-modal', role: 'dialog', 'aria-modal': 'true', onClick: (event) => (event.target === event.currentTarget ? onClose() : null) },
        h(
          'div',
          { className: 'gd-modal-body' },
          h('div', { className: 'gd-row', style: { justifyContent: 'space-between' } },
            h('h3', { style: { margin: 0, fontSize: '15px' } }, `${t('reportTitle')} · ${payload.game} · ${payload.runId}`),
            h('button', { className: 'gd-btn', onClick: onClose }, t('close'))
          ),
          report
            ? h('pre', { className: 'gd-pre' }, JSON.stringify(report, null, 2))
            : h('p', { className: 'gd-empty' }, t('reportNone')),
          payload.stdoutTail ? h('div', null, h('div', { className: 'gd-sub' }, 'headless stdout (tail)'), h('pre', { className: 'gd-pre' }, payload.stdoutTail)) : null,
          h('div', { className: 'gd-detail' }, payload.dir)
        )
      );
    }

    function GamePanel(props) {
      const { t, game, state, draft, dirty, setField, save, disableAll, runNow, stopRun, toggleDay, refreshProbe, probe, probeLoading, busy, openReport, message, fixing } = props;
      const [reportSession, setReportSession] = React.useState(state && state.ui ? state.ui.reportSessions !== false : true);
      React.useEffect(() => {
        setReportSession(state && state.ui ? state.ui.reportSessions !== false : true);
      }, [state && state.ui && state.ui.reportSessions]);
      const [foregroundGuard, setForegroundGuard] = React.useState(state && state.ui ? state.ui.foregroundGuard !== false : true);
      React.useEffect(() => {
        setForegroundGuard(state && state.ui ? state.ui.foregroundGuard !== false : true);
      }, [state && state.ui && state.ui.foregroundGuard]);

      const paused = !game.canRun;
      const task = game.task || {};
      const runs = Array.isArray(game.runs) ? game.runs : [];
      const probeData = probe || null;
      const checks = probeData && Array.isArray(probeData.checks) ? probeData.checks : [];
      const taskNote = task.exists
        ? `${t('taskRegistered')} · ${task.state || ''}${task.nextRunTime ? ` · ${t('nextRun')} ${formatTime(task.nextRunTime)}` : ''}`
        : t('noTask');

      if (paused) {
        return h(
          'div',
          { className: 'gd-card' },
          h('div', { className: 'gd-hero' }, h('h3', null, game.title), Badge({ tone: 'warn', children: t('tabPaused') })),
          h('p', { className: 'gd-detail' }, game.note || t('pausedNote'))
        );
      }

      return h(
        'div',
        { className: 'gd-wrap' },
        h(
          'div',
          { className: 'gd-card' },
          h(
            'div',
            { className: 'gd-hero' },
            h('div', null,
              h('h3', null, game.title),
              h('p', { className: 'gd-sub' }, draft.enabled ? t('enabled') : t('disabled'))
            ),
            h('div', { className: 'gd-row' },
              dirty ? h(Badge, { tone: 'warn', children: t('dirty') }) : null,
              h(Switch, {
                on: draft.enabled,
                label: t('heroOn'),
                onChange: (next) => setField({ enabled: next }),
              })
            )
          ),
          !draft.enabled ? h('p', { className: 'gd-detail' }, t('offHint')) : null,
          draft.enabled
            ? h('div', { className: 'gd-row' },
                h('button', { className: 'gd-btn', disabled: Boolean(busy), onClick: runNow }, t('runNow')),
                game.running && game.running.running
                  ? h('button', { className: 'gd-btn', 'data-danger': '1', onClick: stopRun }, `${t('stop')} (pid ${game.running.pid})`)
                  : null,
                h('button', { className: 'gd-btn', 'data-primary': '1', disabled: Boolean(busy), onClick: save }, busy === 'apply' ? t('saving') : t('saveApply')),
                h('button', { className: 'gd-btn', 'data-danger': '1', disabled: Boolean(busy), onClick: disableAll }, t('disable'))
              )
            : h('div', { className: 'gd-row' },
                h('button', { className: 'gd-btn', 'data-primary': '1', onClick: () => setField({ enabled: true }) }, t('enable'))
              ),
          message ? h('p', { className: 'gd-note' }, message) : null,
          game.running && game.running.running ? h('p', { className: 'gd-hint' }, `${t('running')} · runId ${game.running.runId || '?'} · pid ${game.running.pid}`) : null
        ),

        draft.enabled
          ? h(
              'div',
              { className: 'gd-card' },
              h('p', { className: 'gd-section-title' }, t('sectionSchedule')),
              h(
                'div',
                { className: 'gd-row' },
                h('div', { className: 'gd-field' }, h('label', null, t('time')), h('input', {
                  className: 'gd-input',
                  type: 'time',
                  value: draft.schedule.time,
                  onChange: (event) => setField({ schedule: { ...draft.schedule, time: event.target.value } }),
                })),
                h('div', { className: 'gd-field' }, h('label', null, t('weekdays')), h('select', {
                  className: 'gd-input',
                  value: draft.schedule.weekdays === 'daily' ? 'daily' : 'custom',
                  onChange: (event) =>
                    setField({ schedule: { ...draft.schedule, weekdays: event.target.value === 'daily' ? 'daily' : [1, 2, 3, 4, 5] } }),
                }, h('option', { value: 'daily' }, t('weekdaysDaily')), h('option', { value: 'custom' }, t('weekdaysCustom')))),
                h('div', { className: 'gd-field' }, h('label', null, t('timeout')), h('input', {
                  className: 'gd-input',
                  type: 'number',
                  min: 5,
                  max: 180,
                  value: draft.timeoutMin,
                  onChange: (event) => setField({ timeoutMin: Number(event.target.value) || 0 }),
                })),
                h('div', { className: 'gd-field' }, h('label', null, t('mode')), h('select', {
                  className: 'gd-input',
                  value: draft.mode,
                  onChange: (event) => setField({ mode: event.target.value }),
                }, h('option', { value: 'real' }, t('modeReal')), h('option', { value: 'dry' }, t('modeDry'))))
              ),
              draft.schedule.weekdays !== 'daily'
                ? h('div', { className: 'gd-row' }, DAY_LABELS.map((label, index) => {
                    const day = index + 1;
                    const days = Array.isArray(draft.schedule.weekdays) ? draft.schedule.weekdays : [];
                    const on = days.includes(day);
                    return h('button', {
                      key: day,
                      className: 'gd-day',
                      'data-on': on ? '1' : '0',
                      onClick: () => toggleDay(day),
                    }, label);
                  }))
                : null,
              h(ToggleRow, {
                label: t('catchUp'),
                on: draft.schedule.catchUp !== false,
                onChange: (next) => setField({ schedule: { ...draft.schedule, catchUp: next } }),
              }),
              h(ToggleRow, {
                label: t('foregroundGuard'),
                on: foregroundGuard,
                onChange: async (next) => {
                  setForegroundGuard(next);
                  try {
                    await api('/ui', { method: 'POST', body: JSON.stringify({ foregroundGuard: next }) });
                  } catch (error) {
                    /* 下次刷新会回显真实值 */
                  }
                },
              }),
              h(ToggleRow, {
                label: t('reportSession'),
                on: reportSession,
                onChange: async (next) => {
                  setReportSession(next);
                  try {
                    await api('/ui', { method: 'POST', body: JSON.stringify({ reportSessions: next }) });
                  } catch (error) {
                    /* 下次刷新会回显真实值 */
                  }
                },
              }),
              h('p', { className: 'gd-hint' }, t('autoExitNote')),
              h('div', { className: 'gd-field' }, h('label', null, t('gamePath')),
                h('input', {
                  className: 'gd-input',
                  style: { minWidth: '320px' },
                  value: draft.gamePath,
                  placeholder: game.engine === 'bettergi' ? 'D:\\software\\BetterGI\\BetterGI.exe' : '',
                  onChange: (event) => setField({ gamePath: event.target.value }),
                })),
              h('p', { className: 'gd-detail' }, `${t('taskState')}：${taskNote}`),
              h('p', { className: 'gd-hint' }, t('runHint'))
            )
          : null,

        h(
          'div',
          { className: 'gd-card' },
          h('div', { className: 'gd-row', style: { justifyContent: 'space-between' } },
            h('p', { className: 'gd-section-title' }, t('sectionDeps')),
            h('button', { className: 'gd-btn', disabled: probeLoading, onClick: refreshProbe }, probeLoading ? t('probeLoading') : t('refreshProbe'))
          ),
          checks.length === 0
            ? h('p', { className: 'gd-empty' }, probeLoading ? t('probeLoading') : '—')
            : checks.map((check) =>
                h('div', { key: check.id, className: 'gd-check' },
                  h('div', { className: 'gd-check-head' },
                    h('span', { className: 'gd-chip' },
                      Badge({ tone: check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'warn' : 'missing', children: check.status === 'ok' ? t('statusOk') : check.status === 'warn' ? t('statusWarn') : t('statusMissing') }),
                      h('span', null, check.label),
                      check.blocker ? Badge({ tone: 'missing', children: t('blocker') }) : null
                    ),
                    check.fix ? h('button', {
                      className: 'gd-btn',
                      disabled: fixing === check.id,
                      onClick: () => props.fixDependency(check),
                    }, fixing === check.id ? t('fixing') : t('fix')) : null
                  ),
                  h('div', { className: 'gd-detail' }, check.detail || '')
                )
              )
        ),

        h(
          'div',
          { className: 'gd-card' },
          h('p', { className: 'gd-section-title' }, t('sectionRuns')),
          runs.length === 0
            ? h('p', { className: 'gd-empty' }, t('noRuns'))
            : h('div', { className: 'gd-runs' }, runs.map((run) => {
                const summary = run.summary || {};
                const label = STATUS_ZH[summary.status] || summary.status || '?';
                return h('div', { key: run.runId, className: 'gd-run' },
                  h('span', { className: 'gd-chip' },
                    Badge({ tone: STATUS_TONE[summary.status] || 'warn', children: label }),
                    h('span', null, run.runId),
                    run.meta && run.meta.trigger === 'schedule' ? h('span', { className: 'gd-detail' }, '计划任务') : null
                  ),
                  h('button', {
                    className: 'gd-btn',
                    onClick: async () => {
                      try {
                        const payload = await api(`/run?game=${encodeURIComponent(game.id)}&runId=${encodeURIComponent(run.runId)}`);
                        openReport(payload);
                      } catch (error) {
                        openReport({ game: game.id, runId: run.runId, report: null, dir: '', stdoutTail: String(error.message || error) });
                      }
                    },
                  }, t('viewReport'))
                );
              }))
        )
      );
    }

    function formatTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    }

    function Panel(props) {
      const { t, clientCtx } = props;
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [tab, setTab] = React.useState('genshin');
      const [drafts, setDrafts] = React.useState({});
      const [dirty, setDirty] = React.useState({});
      const dirtyRef = React.useRef({});
      const [probe, setProbe] = React.useState({});
      const [probeLoading, setProbeLoading] = React.useState(false);
      const [busy, setBusy] = React.useState('');
      const [fixing, setFixing] = React.useState('');
      const [message, setMessage] = React.useState('');
      const [report, setReport] = React.useState(null);
      const [update, setUpdate] = React.useState(null);
      const [updateBusy, setUpdateBusy] = React.useState('');
      const [updateHidden, setUpdateHidden] = React.useState(false);

      const checkUpdate = async (force) => {
        try {
          const value = await api(`/update${force ? '?force=1' : ''}`);
          setUpdate(value);
        } catch (err) {
          setUpdate({ ok: false, hasUpdate: false, error: String(err.message || err) });
        }
      };

      React.useEffect(() => {
        checkUpdate(false);
      }, []);

      const runUpdate = async () => {
        if (updateBusy) return;
        setUpdateBusy('update');
        setMessage('');
        try {
          const value = await api('/update', { method: 'POST', body: '{}' });
          setUpdateHidden(false);
          setMessage(t('updateDone').replace('{version}', value.to || ''));
          await checkUpdate(true);
          await load(true);
        } catch (err) {
          setMessage(`${t('error')}: ${String(err.message || err)}`);
        } finally {
          setUpdateBusy('');
        }
      };

      const load = async (silent) => {
        try {
          const value = await api('/state');
          setState(value);
          setError('');
          if (!silent) {
            setTab((current) => (value.games.some((game) => game.id === current) ? current : value.ui.lastGame || 'genshin'));
          }
          setDrafts((current) => {
            const next = { ...current };
            for (const game of value.games) {
              // 有未保存改动的游戏不被轮询覆盖（dirtyRef 是同步最新值，不能用闭包里的 dirty）。
              if (!dirtyRef.current[game.id]) next[game.id] = settingsDraftOf(value, game.id);
            }
            return next;
          });
        } catch (err) {
          setError(String(err.message || err));
        }
      };

      React.useEffect(() => {
        load(false);
        const timer = setInterval(() => load(true), 6000);
        return () => clearInterval(timer);
      }, []);

      React.useEffect(() => {
        if (!state) return;
        setDrafts((current) => (current[tab] ? current : { ...current, [tab]: settingsDraftOf(state, tab) }));
        refreshProbe(tab);
      }, [state && state.games && state.games.length, tab]);

      const refreshProbe = async (gameId) => {
        setProbeLoading(true);
        try {
          const value = await api(`/probe?games=${encodeURIComponent(gameId || tab)}`);
          setProbe((current) => ({ ...current, [gameId || tab]: value }));
        } catch (err) {
          setProbe((current) => ({ ...current, [gameId || tab]: { checks: [{ id: 'probe', label: 'probe', status: 'missing', detail: String(err.message || err) }] } }));
        } finally {
          setProbeLoading(false);
        }
      };

      const game = state && Array.isArray(state.games) ? state.games.find((item) => item.id === tab) : null;
      const draft = drafts[tab] || (state ? settingsDraftOf(state, tab) : null);

      const setField = (patch) => {
        setDrafts((current) => ({
          ...current,
          [tab]: {
            ...(current[tab] || settingsDraftOf(state, tab)),
            ...patch,
            schedule: patch.schedule ? { ...(current[tab] || settingsDraftOf(state, tab)).schedule, ...patch.schedule } : (current[tab] || settingsDraftOf(state, tab)).schedule,
          },
        }));
        setDirty((current) => ({ ...current, [tab]: true }));
        dirtyRef.current = { ...dirtyRef.current, [tab]: true };
        setMessage('');
      };

      const toggleDay = (day) => {
        const current = draft.schedule.weekdays === 'daily' ? [] : [...draft.schedule.weekdays];
        const index = current.indexOf(day);
        if (index >= 0) current.splice(index, 1);
        else current.push(day);
        current.sort((a, b) => a - b);
        setField({ schedule: { ...draft.schedule, weekdays: current } });
      };

      const selectTab = (gameId) => {
        setTab(gameId);
        setMessage('');
        api('/ui', { method: 'POST', body: JSON.stringify({ lastGame: gameId }) }).catch(() => {});
      };

      const save = async () => {
        setBusy('apply');
        setMessage('');
        try {
          const payload = { games: { [tab]: draft } };
          const value = await api('/apply', { method: 'POST', body: JSON.stringify(payload) });
          setDirty((current) => ({ ...current, [tab]: false }));
          dirtyRef.current = { ...dirtyRef.current, [tab]: false };
          setMessage(value.note || t('applied'));
          await load(true);
        } catch (err) {
          setMessage(`${t('error')}: ${String(err.message || err)}`);
        } finally {
          setBusy('');
        }
      };

      const disableAll = async () => {
        setBusy('disable');
        setMessage('');
        try {
          await api('/disable', { method: 'POST', body: '{}' });
          setDirty({});
          dirtyRef.current = {};
          setMessage(t('applied'));
          await load(true);
        } catch (err) {
          setMessage(`${t('error')}: ${String(err.message || err)}`);
        } finally {
          setBusy('');
        }
      };

      const runNow = async () => {
        setBusy('run');
        setMessage('');
        try {
          const value = await api('/run', { method: 'POST', body: JSON.stringify({ game: tab }) });
          setMessage(`${t('running')} · runId ${value.runId} · pid ${value.pid}`);
          await load(true);
        } catch (err) {
          setMessage(`${t('error')}: ${String(err.message || err)}`);
        } finally {
          setBusy('');
        }
      };

      const stopRun = async () => {
        setBusy('stop');
        try {
          const value = await api('/stop', { method: 'POST', body: JSON.stringify({ game: tab }) });
          setMessage(value.ok ? `stopped pid ${value.killed}` : String(value.error || ''));
          await load(true);
        } catch (err) {
          setMessage(`${t('error')}: ${String(err.message || err)}`);
        } finally {
          setBusy('');
        }
      };

      const fixDependency = async (check) => {
        const fix = check.fix || {};
        const action = String(fix.action || check.id);
        if (fixing) return;
        setFixing(check.id);
        setMessage(action === 'install-zzz-od' ? t('installingZzz') : action === 'start-zzz-server' ? t('zzzServerStarting') : t('fixing'));
        try {
          const value = await api('/install', {
            method: 'POST',
            body: JSON.stringify({
              action,
              game: tab,
              checkId: check.id,
              checkDetail: check.detail || '',
              title: `游戏日常 · 修复 ${check.label || check.id}`,
            }),
          });
          if (value.sessionId) {
            try {
              const sessions = clientCtx && clientCtx.sessions ? clientCtx.sessions : null;
              if (sessions && typeof sessions.open === 'function') sessions.open(value.sessionId);
            } catch {
              /* 打不开就只提示 */
            }
          }
          if (value.ok === true && !value.sessionId) {
            if (action === 'install-zzz-od') {
              setMessage(value.note || t('zzzInstalled'));
              await load(true);
              await refreshProbe(tab);
              return;
            }
            if (action === 'start-zzz-server') {
              setMessage(value.note || t('zzzServerStarting'));
              await refreshProbe(tab);
              return;
            }
            if (action === 'install-bettergi-mcp' || action === 'fix-bettergi-mcp') {
              setMessage(value.note || t('mcpRegistered'));
              await load(true);
              await refreshProbe(tab);
              return;
            }
            if (action === 'install-bettergi-skill') {
              setMessage(value.note || t('skillInstalled'));
              await refreshProbe(tab);
              return;
            }
          }
          setMessage(`${t('fixed')}${value.sessionId ? ` (session ${value.sessionId.slice(0, 8)}…)` : ''}`);
        } catch (err) {
          setMessage(`${t('error')}: ${String(err.message || err)}`);
        } finally {
          setFixing('');
        }
      };

      const tabs = state ? state.games : [
        { id: 'genshin', title: '原神', canRun: true },
        { id: 'hi', title: '崩坏3', canRun: true },
        { id: 'sr', title: '崩坏：星穹铁道', canRun: true },
        { id: 'zzz', title: '绝区零', canRun: false },
      ];

      const version = (state && state.version) || (update && update.current) || '';
      const showUpdate = Boolean(update && update.hasUpdate && !updateHidden);
      const fill = (template, values) =>
        String(template || '').replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])));

      const updateBlock = h('div', { className: 'gd-update', 'data-tone': showUpdate ? 'warn' : 'ok' },
        h('div', { className: 'gd-update-head' },
          h('h3', { className: 'gd-update-title' },
            showUpdate
              ? `${t('updateFound')} v${update.latest}`
              : update && update.ok === false
                ? t('updateFailed')
                : `${t('versionLabel')} v${version} · ${t('updateIsLatest')}`
          ),
          h('div', { className: 'gd-update-actions' },
            showUpdate
              ? [
                  h('button', { key: 'now', className: 'gd-btn', 'data-primary': '1', disabled: Boolean(updateBusy), onClick: runUpdate }, updateBusy ? t('updateRunning') : t('updateNow')),
                  h('button', { key: 'later', className: 'gd-btn', onClick: () => setUpdateHidden(true) }, t('updateLater')),
                  update.releases ? h('a', { key: 'notes', className: 'gd-link', href: update.releases, target: '_blank', rel: 'noreferrer' }, t('updateNotes')) : null,
                ]
              : h('button', { key: 'check', className: 'gd-link', onClick: () => checkUpdate(true) }, updateBusy ? t('updateChecking') : t('updateChecking'))
          )
        ),
        showUpdate ? h('p', { className: 'gd-update-body' }, fill(t('updateBody'), { latest: update.latest, current: update.current })) : null,
        showUpdate ? h('p', { className: 'gd-update-body' }, t('updateRestartHint')) : null,
        update && update.ok === false && !updateHidden ? h('p', { className: 'gd-update-body' }, String(update.error || '')) : null
      );

      return h(
        'div',
        { className: 'gd-wrap' },
        h('div', null,
          h('h2', { style: { margin: '0 0 4px', fontSize: '18px' } }, t('title')),
          h('p', { className: 'gd-sub', style: { margin: 0 } }, t('subtitle'))
        ),
        error ? h('p', { className: 'gd-hint' }, `${t('error')}: ${error}`) : null,
        updateBlock,
        h('div', { className: 'gd-tabs', role: 'tablist' }, tabs.map((item) =>
          h('button', {
            key: item.id,
            role: 'tab',
            'aria-selected': item.id === tab ? 'true' : 'false',
            className: 'gd-tab',
            'data-active': item.id === tab ? '1' : '0',
            'data-disabled': item.canRun === false ? '1' : '0',
            onClick: () => selectTab(item.id),
          }, item.canRun === false ? `${item.title} · ${t('tabPaused')}` : item.title)
        )),
        !state
          ? h('p', { className: 'gd-empty' }, t('loading'))
          : game && draft
            ? h(GamePanel, {
                t,
                game,
                state,
                draft,
                dirty: Boolean(dirty[tab]),
                setField,
                save,
                disableAll,
                runNow,
                stopRun,
                toggleDay,
                probe: probe[tab],
                probeLoading,
                refreshProbe: () => refreshProbe(tab),
                fixDependency,
                fixing,
                busy,
                message,
                openReport: setReport,
              })
            : h('p', { className: 'gd-empty' }, t('loading')),
        report ? h(ReportModal, { payload: report, onClose: () => setReport(null), t }) : null
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'game-daily: locale');
      const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => (dictionaries.zh[key] || key);
      const style = document.createElement('style');
      style.setAttribute('data-plugin-css', 'dsh-game-daily');
      style.textContent = CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), 'game-daily: style');
      const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : null) || ctx.slots;
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'game-daily',
            order: 35,
            label: () => t('nav'),
            locale: NS,
          },
          () => h(Panel, { t, clientCtx: ctx })
        )
      );
    }

    return { apply, inject: ['slots', 'locale'] };
  },
});
