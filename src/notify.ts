import { execFile } from "node:child_process";
import { settings } from "./config.js";
import { log } from "./util.js";

const powershellString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A system notification, so a stop reaches the user even when they aren't chatting with Claude. Best effort. */
export function notify(title: string, message: string): void {
  if (settings.fakePoster) return;
  const done = (e: Error | null) => {
    if (e) log("notification failed:", e.message);
  };
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], done);
  } else if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$n = New-Object System.Windows.Forms.NotifyIcon",
      "$n.Icon = [System.Drawing.SystemIcons]::Warning",
      "$n.Visible = $true",
      `$n.ShowBalloonTip(15000, ${powershellString(title)}, ${powershellString(message)}, 'Warning')`,
      "Start-Sleep -Seconds 15",
      "$n.Dispose()",
    ].join("; ");
    execFile("powershell", ["-NoProfile", "-Command", script], { windowsHide: true }, done);
  }
}
