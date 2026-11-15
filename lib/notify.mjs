// 收工通知：Windows toast（失败就只写日志，绝不让通知把运行本身搞挂）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

function psSingle(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName('text')
  $texts.Item(0).AppendChild($template.CreateTextNode($TITLE)) | Out-Null
  $texts.Item(1).AppendChild($template.CreateTextNode($BODY)) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($APPID)
  $notifier.Show($toast)
  '{"ok":true}'
} catch {
  ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message } -Compress
}
`.trim();

/**
 * 发一条系统通知。返回 {ok, error?}；任何异常都被吞掉并记进 notifications.log。
 */
export function notify({ stateDir, title, body, appId = 'DeepSeek Harness · 游戏日常' }) {
  const logFile = stateDir ? path.join(stateDir, 'notifications.log') : '';
  const line = `[${new Date().toISOString()}] ${title} | ${body}\n`;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, line, 'utf8');
    } catch {
      /* ignore */
    }
  }
  const script = `$ErrorActionPreference = 'Stop'
$TITLE = ${psSingle(title)}
$BODY = ${psSingle(body)}
$APPID = ${psSingle(appId)}
${TOAST_SCRIPT}`;
  try {
    const stdout = execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 12000,
    });
    const parsed = JSON.parse(String(stdout || '{}').trim() || '{}');
    return parsed && parsed.ok === true ? { ok: true } : { ok: false, error: parsed && parsed.error ? parsed.error : 'toast failed' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}
