import QtQuick
import Quickshell
import Quickshell.Io

// Polls `omarchy-assistant status --json` and exposes the daemon state.
// Every action goes back through the same CLI, so the widget never touches
// the socket or the vault itself.
Item {
  id: root

  property var settings: ({})

  property bool available: false
  property bool listening: true
  property bool thinking: false
  property int pending: 0
  property string lastReply: ""
  property real todayCostUsd: 0
  property string model: ""
  property var proposals: []
  property var devices: []
  property string lastError: ""
  property string actionStatus: ""

  readonly property int refreshIntervalSec: {
    var n = parseInt(String(settings && settings.refreshIntervalSec !== undefined ? settings.refreshIntervalSec : 30), 10)
    if (!isFinite(n)) n = 30
    return Math.max(5, Math.min(600, n))
  }
  readonly property bool busy: statusProcess.running || actionProcess.running

  function note(message) {
    actionStatus = String(message || "")
    if (actionStatus !== "") actionStatusTimer.restart()
  }

  function refresh() {
    if (statusProcess.running) return
    statusProcess.command = ["timeout", "5", "omarchy-assistant", "status", "--json"]
    statusProcess.running = true
  }

  function apply(raw) {
    var data = null
    try { data = JSON.parse(String(raw || "")) } catch (e) { data = null }
    if (!data || typeof data !== "object") {
      available = false
      lastError = "Daemon not running"
      proposals = []
      return
    }
    available = true
    lastError = ""
    listening = data.listening !== false
    thinking = data.thinking === true
    pending = Number(data.pending || 0)
    lastReply = String(data.lastReply || "")
    todayCostUsd = Number(data.todayCostUsd || 0)
    model = String(data.model || "")
    proposals = data.proposals instanceof Array ? data.proposals : []
    devices = data.devices instanceof Array ? data.devices : []
  }

  function act(args, message) {
    if (actionProcess.running) return
    note(message)
    actionProcess.command = ["omarchy-assistant"].concat(args)
    actionProcess.running = true
  }

  function toggleListening() { act(["listen", "toggle"], listening ? "Listening off" : "Listening on") }
  function accept(id) { act(["accept", String(id)], "Added") }
  function dismiss(id) { act(["dismiss", String(id)], "Dismissed") }
  function review() { Quickshell.execDetached(["omarchy-assistant", "review"]) }
  function openVault() { Quickshell.execDetached(["omarchy-launch-or-focus", "obsidian", "obsidian"]) }
  function openChat() { Quickshell.execDetached(["omarchy-assistant", "open-chat", "local"]) }

  Component.onCompleted: refresh()

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    onTriggered: root.refresh()
  }

  Timer {
    id: delayedRefresh
    interval: 800
    repeat: false
    onTriggered: root.refresh()
  }

  Timer {
    id: actionStatusTimer
    interval: 2400
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Process {
    id: statusProcess
    running: false
    command: []
    stdout: StdioCollector { id: statusStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) root.apply(statusStdout.text)
      else root.apply("")
    }
  }

  Process {
    id: actionProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { id: actionStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.lastError = String(actionStderr.text || "").split("\n")[0] || "command failed"
      delayedRefresh.restart()
    }
  }
}
