import AppKit
import Darwin
import Foundation
import UserNotifications

private enum LauncherError: LocalizedError {
    case missingResources
    case missingRuntime
    case missingSidecar

    var errorDescription: String? {
        switch self {
        case .missingResources:
            return "App 资源目录不完整，请重新构建 Codex Continuity。"
        case .missingRuntime:
            return "未找到 Codex 自带运行时。请先将 Codex 安装到“应用程序”目录。"
        case .missingSidecar:
            return "Continuity 后台服务缺失，请重新构建 App。"
        }
    }
}

private struct AttentionEvent: Decodable {
    let type: String
    let threadId: String
    let turnId: String
    let project: String
    let nativeTitle: String
    let chapter: String
    let excerpt: String
    let deepLink: String
}

private struct AttentionSnapshot: Decodable {
    let type: String
    let items: [AttentionEvent]
}

private struct TitleChangeEvent: Decodable {
    let type: String
    let threadId: String
    let previousTitle: String
    let title: String
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private enum NotificationAvailability {
        case checking
        case available
        case unavailable
    }

    private var helper: Process?
    private var helperOutput: Pipe?
    private var helperInput: Pipe?
    private var logHandle: FileHandle?
    private var logURL: URL?
    private var outputBuffer = ""
    private var statusItem: NSStatusItem?
    private var attentionEvents: [AttentionEvent] = []
    private var latestTitleChange: TitleChangeEvent?
    private var notificationAvailability = NotificationAvailability.checking
    private var isTerminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        installStatusItem()
        requestNotificationAuthorization()

        do {
            try startContinuity()
        } catch {
            presentFailure(error.localizedDescription)
            NSApp.terminate(nil)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let helper, helper.isRunning else {
            return .terminateNow
        }

        isTerminating = true
        helper.terminationHandler = { _ in
            DispatchQueue.main.async {
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
        helper.terminate()

        let pid = helper.processIdentifier
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if helper.isRunning {
                kill(pid, SIGKILL)
            }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        helperOutput?.fileHandleForReading.readabilityHandler = nil
        try? logHandle?.close()
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(
            systemSymbolName: "arrow.triangle.2.circlepath",
            accessibilityDescription: "Codex Continuity"
        )
        item.button?.imagePosition = .imageLeading
        statusItem = item
        rebuildStatusMenu()
    }

    private func rebuildStatusMenu() {
        guard let statusItem else { return }
        let menu = NSMenu()
        let status = NSMenuItem(
            title: attentionEvents.isEmpty ? "正在维护 Codex 标题" : "有 \(attentionEvents.count) 个新结果",
            action: nil,
            keyEquivalent: ""
        )
        status.isEnabled = false
        menu.addItem(status)

        if attentionEvents.isEmpty {
            let empty = NSMenuItem(title: "暂无新结果", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            menu.addItem(.separator())
            for event in attentionEvents.prefix(3) {
                let title = event.chapter.isEmpty ? event.nativeTitle : event.chapter
                let resultItem = NSMenuItem(
                    title: "\(event.project) · \(title)",
                    action: #selector(openAttention(_:)),
                    keyEquivalent: ""
                )
                resultItem.target = self
                resultItem.representedObject = event.deepLink
                resultItem.toolTip = event.excerpt
                menu.addItem(resultItem)
            }
        }

        if notificationAvailability == .unavailable {
            menu.addItem(.separator())
            let notificationStatus = NSMenuItem(
                title: "系统通知未开启；新结果仍会保留在这里",
                action: nil,
                keyEquivalent: ""
            )
            notificationStatus.isEnabled = false
            menu.addItem(notificationStatus)
        }

        if let change = latestTitleChange {
            menu.addItem(.separator())
            let undoTitleItem = NSMenuItem(
                title: "撤销标题“\(change.title)”",
                action: #selector(undoLatestTitle),
                keyEquivalent: "z"
            )
            undoTitleItem.target = self
            menu.addItem(undoTitleItem)
        }

        menu.addItem(.separator())
        let openCodexItem = NSMenuItem(
            title: "打开官方 Codex",
            action: #selector(openCodex),
            keyEquivalent: "o"
        )
        openCodexItem.target = self
        menu.addItem(openCodexItem)

        let openLogItem = NSMenuItem(
            title: "打开运行日志",
            action: #selector(openLog),
            keyEquivalent: "l"
        )
        openLogItem.target = self
        menu.addItem(openLogItem)
        menu.addItem(.separator())

        let quitItem = NSMenuItem(
            title: "退出 Codex Continuity",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        menu.addItem(quitItem)
        statusItem.menu = menu
        statusItem.button?.title = attentionEvents.isEmpty ? "" : " \(attentionEvents.count)"
    }

    private func requestNotificationAuthorization() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                self.updateNotificationAvailability(.available)
            case .denied:
                self.updateNotificationAvailability(.unavailable)
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    if let error {
                        self.appendLog("通知权限不可用：\(error.localizedDescription)\n")
                    }
                    self.updateNotificationAvailability(granted ? .available : .unavailable)
                }
            @unknown default:
                self.updateNotificationAvailability(.unavailable)
            }
        }
    }

    private func updateNotificationAvailability(_ availability: NotificationAvailability) {
        DispatchQueue.main.async {
            let changed = self.notificationAvailability != availability
            self.notificationAvailability = availability
            self.rebuildStatusMenu()
            if changed {
                let state = availability == .available ? "可用" : "不可用，已降级为菜单栏"
                self.appendLog("系统通知状态：\(state)。\n")
            }
        }
    }

    private func startContinuity() throws {
        guard let resourcesURL = Bundle.main.resourceURL else {
            throw LauncherError.missingResources
        }

        let runtimeURL = try resolveCodexRuntime()
        let sidecarURL = resourcesURL
            .appendingPathComponent("app", isDirectory: true)
            .appendingPathComponent("src", isDirectory: true)
            .appendingPathComponent("sidecar.mjs")
        guard FileManager.default.fileExists(atPath: sidecarURL.path) else {
            throw LauncherError.missingSidecar
        }

        let logsDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Codex Continuity", isDirectory: true)
        try FileManager.default.createDirectory(
            at: logsDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let logURL = logsDirectory.appendingPathComponent("launcher.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        let logHandle = try FileHandle(forWritingTo: logURL)
        try logHandle.seekToEnd()
        self.logHandle = logHandle
        self.logURL = logURL
        appendLog("\n[\(ISO8601DateFormatter().string(from: Date()))] Codex Continuity 原生标题维护层启动\n")

        let output = Pipe()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            self?.consumeHelperOutput(data)
        }

        let process = Process()
        let input = Pipe()
        process.executableURL = runtimeURL
        process.arguments = [sidecarURL.path]
        process.currentDirectoryURL = resourcesURL.appendingPathComponent("app", isDirectory: true)
        process.standardInput = input
        process.standardOutput = output
        process.standardError = logHandle

        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        environment.removeValue(forKey: "NODE_OPTIONS")
        environment.removeValue(forKey: "NODE_INSPECTOR_IPC")
        environment.removeValue(forKey: "CODEX_THREAD_ID")
        process.environment = environment

        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, !self.isTerminating else { return }
                if process.terminationStatus != 0 {
                    self.presentFailure("Continuity 后台服务意外退出。可从菜单栏打开运行日志查看原因。")
                }
                NSApp.terminate(nil)
            }
        }

        try process.run()
        self.helper = process
        self.helperOutput = output
        self.helperInput = input
    }

    private func consumeHelperOutput(_ data: Data) {
        outputBuffer += String(decoding: data, as: UTF8.self)
        while let newline = outputBuffer.firstIndex(of: "\n") {
            let line = String(outputBuffer[..<newline])
            outputBuffer.removeSubrange(...newline)
            if line.hasPrefix("{\"type\":\"attention") || line.hasPrefix("{\"type\":\"title_") {
                appendLog("菜单栏结果状态已更新。\n")
            } else {
                appendLog("\(line)\n")
            }
            handleHelperLine(line)
        }
    }

    private func handleHelperLine(_ line: String) {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }

        if type == "attention_snapshot",
           let snapshot = try? JSONDecoder().decode(AttentionSnapshot.self, from: data) {
            DispatchQueue.main.async {
                self.attentionEvents = snapshot.items
                self.rebuildStatusMenu()
            }
            return
        }

        if type == "title_changed",
           let event = try? JSONDecoder().decode(TitleChangeEvent.self, from: data) {
            DispatchQueue.main.async {
                self.latestTitleChange = event
                self.rebuildStatusMenu()
            }
            return
        }
        if type == "title_undone" {
            DispatchQueue.main.async {
                self.latestTitleChange = nil
                self.rebuildStatusMenu()
            }
            return
        }
        if type == "title_undo_failed" {
            DispatchQueue.main.async {
                self.latestTitleChange = nil
                self.rebuildStatusMenu()
                self.appendLog("标题撤销未执行：原生标题可能已经被手动修改。\n")
            }
            return
        }

        guard type == "attention",
              let event = try? JSONDecoder().decode(AttentionEvent.self, from: data) else { return }
        DispatchQueue.main.async {
            self.attentionEvents.removeAll { $0.threadId == event.threadId }
            self.attentionEvents.insert(event, at: 0)
            self.attentionEvents = Array(self.attentionEvents.prefix(3))
            self.rebuildStatusMenu()
            self.deliverNotification(event)
        }
    }

    private func deliverNotification(_ event: AttentionEvent) {
        guard notificationAvailability == .available else { return }
        let content = UNMutableNotificationContent()
        content.title = event.chapter.isEmpty ? event.nativeTitle : event.chapter
        content.subtitle = event.project
        content.body = event.excerpt
        content.sound = .default
        content.userInfo = ["deepLink": event.deepLink]
        let identifier = "continuity-\(event.threadId)-\(event.turnId)"
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        ) { error in
            guard let error else { return }
            self.appendLog("通知发送失败：\(error.localizedDescription)\n")
            self.updateNotificationAvailability(.unavailable)
        }
    }

    @objc private func undoLatestTitle() {
        guard let change = latestTitleChange,
              let data = try? JSONSerialization.data(withJSONObject: [
                  "type": "undo_title",
                  "threadId": change.threadId,
              ]) else { return }
        helperInput?.fileHandleForWriting.write(data)
        helperInput?.fileHandleForWriting.write(Data("\n".utf8))
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let deepLink = response.notification.request.content.userInfo["deepLink"] as? String {
            openDeepLink(deepLink)
        }
        completionHandler()
    }

    private func resolveCodexRuntime() throws -> URL {
        let taskHome = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
            "\(taskHome)/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
            "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
            "\(taskHome)/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
        ]

        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        throw LauncherError.missingRuntime
    }

    @objc private func openAttention(_ sender: NSMenuItem) {
        guard let deepLink = sender.representedObject as? String else { return }
        openDeepLink(deepLink)
    }

    private func openDeepLink(_ value: String) {
        guard let url = URL(string: value) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openCodex() {
        let taskHome = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "/Applications/Codex.app",
            "\(taskHome)/Applications/Codex.app",
            "/Applications/ChatGPT.app",
            "\(taskHome)/Applications/ChatGPT.app",
        ]
        guard let path = candidates.first(where: FileManager.default.fileExists(atPath:)) else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.openApplication(
            at: URL(fileURLWithPath: path),
            configuration: configuration,
            completionHandler: nil
        )
    }

    @objc private func openLog() {
        guard let logURL else { return }
        NSWorkspace.shared.open(logURL)
    }

    private func appendLog(_ value: String) {
        guard let data = value.data(using: .utf8) else { return }
        try? logHandle?.write(contentsOf: data)
    }

    private func presentFailure(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Codex Continuity 无法启动"
        alert.informativeText = message
        alert.addButton(withTitle: "退出")
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
