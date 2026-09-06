import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell.Io
import qs.Commons
import qs.Ui

// Bar widget for the Omarchy assistant. Left click opens the panel, right
// click toggles ambient listening, middle click opens the review menu.
Panel {
  id: root
  moduleName: "wearable.assistant"
  ipcTarget: "wearable.assistant"
  manageIpc: false

  property int cursor: -1

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // Microphone, not a robot: omarchy.agents already uses the robot glyph.
  readonly property string glyph: !assistant.available ? "󰍭"
    : assistant.thinking ? "󰔟"
    : !assistant.listening ? "󰍭"
    : "󰍬"
  readonly property string stateText: !assistant.available ? "Daemon not running"
    : assistant.thinking ? "Thinking…"
    : assistant.listening ? "Listening" : "Muted"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function selected() {
    if (cursor < 0 || cursor >= assistant.proposals.length) return null
    return assistant.proposals[cursor]
  }

  onOpenedChanged: if (opened) {
    cursor = -1
    assistant.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Service {
    id: assistant
    settings: root.settings
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { assistant.refresh(); return "ok" }
    function status(): string { return root.stateText }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.glyph
    active: assistant.pending > 0
    dimmed: !assistant.available || !assistant.listening
    tooltipText: assistant.pending > 0 ? assistant.pending + " suggestion" + (assistant.pending === 1 ? "" : "s") + " waiting" : root.stateText
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) assistant.toggleListening()
      else if (buttonCode === Qt.MiddleButton) assistant.review()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(520))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (assistant.proposals.length === 0) return
        if (dy > 0) root.cursor = Math.min(assistant.proposals.length - 1, root.cursor + 1)
        else if (dy < 0) root.cursor = Math.max(0, root.cursor - 1)
      }
      onActivateRequested: { var p = root.selected(); if (p) assistant.accept(p.id) }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        var p = root.selected()
        if (t === "l" || t === "L") assistant.toggleListening()
        else if (t === "r" || t === "R") { assistant.review(); root.close() }
        else if (t === "o" || t === "O") { assistant.openVault(); root.close() }
        else if (t === "c" || t === "C") { assistant.openChat(); root.close() }
        else if ((t === "a" || t === "A") && p) assistant.accept(p.id)
        else if ((t === "d" || t === "D") && p) assistant.dismiss(p.id)
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "Omarchy"
            meta: root.stateText
            detail: assistant.available && assistant.todayCostUsd > 0 ? "$" + assistant.todayCostUsd.toFixed(3) + " today" : ""
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: assistant.listening ? 1.0 : 0.5
            iconComponent: Component {
              Text {
                text: root.glyph
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }
            trailingControl: Component {
              ToggleSwitch {
                visible: assistant.available
                checked: assistant.listening
                busy: assistant.busy
                foreground: root.foreground
                onToggled: assistant.toggleListening()
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: assistant.actionStatus !== "" || assistant.lastError !== ""
            width: parent.width
            text: assistant.actionStatus !== "" ? assistant.actionStatus : assistant.lastError
            color: assistant.lastError !== "" && assistant.actionStatus === "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          PanelSeparator { visible: assistant.lastReply !== ""; foreground: root.foreground }

          Column {
            visible: assistant.lastReply !== ""
            width: parent.width
            spacing: Style.space(8)
            PanelSectionHeader { text: "LAST REPLY"; foreground: root.foreground; fontFamily: root.fontFamily }
            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: assistant.lastReply
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }
          }

          PanelSeparator { foreground: root.foreground }

          Column {
            width: parent.width
            spacing: Style.space(6)
            PanelSectionHeader {
              text: assistant.proposals.length > 0 ? "SUGGESTIONS  (a accept · d dismiss)" : "SUGGESTIONS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }
            Text {
              visible: assistant.proposals.length === 0
              width: parent.width
              textFormat: Text.PlainText
              text: "Nothing waiting. Overheard commitments show up here."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
            Repeater {
              model: assistant.proposals
              CursorSurface {
                required property var modelData
                required property int index
                width: parent.width
                implicitHeight: rowText.implicitHeight + Style.spacing.rowPaddingX
                foreground: root.foreground
                hasCursor: root.cursor === index
                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  acceptedButtons: Qt.LeftButton | Qt.RightButton
                  onEntered: root.cursor = index
                  onClicked: function(mouse) {
                    if (mouse.button === Qt.RightButton) assistant.dismiss(modelData.id)
                    else assistant.accept(modelData.id)
                  }
                }
                Text {
                  id: rowText
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.margins: Style.space(10)
                  textFormat: Text.PlainText
                  text: (modelData.kind === "event" ? "󰃭 " : "󰄬 ") + modelData.text + (modelData.when ? "  ·  " + modelData.when : "")
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  wrapMode: Text.WordWrap
                }
              }
            }
          }

          PanelSeparator { foreground: root.foreground }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: "l listening · r review · c chat · o vault"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }
        }
      }
    }
  }
}
