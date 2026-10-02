import AppKit
import ApplicationServices
import CryptoKit
import Foundation

// Accessibility is a transport, not a universal meeting/speaker protocol. Keep
// platform recognition separate from AX traversal; unknown evidence stays unknown.
private struct AXNode: Codable {
    var role: String
    var title: String?
    var description: String?
    var value: String?
    var help: String?
    var identifier: String?
    var documentId: String?
    var classList: [String]?
    var url: String?
    var children: [AXNode]?
    var incomplete: Bool?
    var speakerIncomplete: Bool?
}

private struct BrowserTree: Codable {
    var browser: String
    var running: Bool
    var root: AXNode?
    /// Accessibility lists only windows on the current desktop (Space). A
    /// full-screen Meet window on another Space is invisible to it, but not to
    /// the window server; this records that such windows exist.
    var offscreenWindows: Bool? = nil
}
private struct Fixture: Codable { var browsers: [BrowserTree] }
private struct Participant: Codable {
    var id: String
    var name: String
    var `self`: Bool
    var speaking: Bool
}
private struct Snapshot: Codable {
    var meeting: String
    var joined: Bool
    var participants: [Participant]
}
private struct Probe: Codable {
    var state: String
    var detail: String
    var browser: String?
    var snapshot: Snapshot?
    var absenceConfirmed: Bool? = nil
    var accessibilityTrusted: Bool? = nil
    var transport: String = "accessibility"
}

private let permissionHelp = "Enable Accessibility for Seashell (or its terminal host) in System Settings → Privacy & Security → Accessibility, then check again. Browser developer settings are not needed."
private let maxNodes = 3_000
private let maxDepth = 48
private let maxChildren = 300
private let maxStringLength = 1_024

private func clean(_ value: String?) -> String? {
    guard let value, value.count <= maxStringLength else { return nil }
    let text = value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && $0.properties.generalCategory != .format }
    let result = String(String.UnicodeScalarView(text)).trimmingCharacters(in: .whitespacesAndNewlines)
    return result.isEmpty ? nil : result
}

private func matches(_ pattern: String, _ text: String) -> Bool {
    text.range(of: pattern, options: .regularExpression) != nil
}

private func meetPath(_ address: String?) -> String? {
    guard let address, let url = URLComponents(string: address),
          url.scheme == "https", url.host == "meet.google.com",
          url.user == nil, url.password == nil, url.port == nil,
          matches("^/[a-z]{3}-[a-z]{4}-[a-z]{3}$", url.path) else { return nil }
    return url.path
}

private func labels(_ node: AXNode) -> [String] {
    [node.title, node.description, node.value, node.help].compactMap(clean)
}

private func walk(_ root: AXNode) -> [AXNode] {
    var output: [AXNode] = [], pending = [(root, 0)]
    while let (node, depth) = pending.popLast() {
        if depth > maxDepth || (node.children?.count ?? 0) > maxChildren {
            output.append(AXNode(role: "AXUnknown", incomplete: true)); break
        }
        output.append(node)
        if output.count > maxNodes { break }
        if node.role == "AXWebArea" && meetPath(node.url) == nil { continue }
        pending.append(contentsOf: (node.children ?? []).map { ($0, depth + 1) })
    }
    return output
}

private func browserScaffold(_ root: AXNode, stopAtWindows: Bool = false) -> [AXNode] {
    var result: [AXNode] = [], pending = [root]
    while let node = pending.popLast() {
        result.append(node)
        if result.count > maxNodes { break }
        // In-page radio buttons are not browser tabs; neither their labels nor
        // nested iframe contents may affect the browser's tab inventory.
        if node.role != "AXWebArea" && !(stopAtWindows && node.role == "AXWindow") { pending.append(contentsOf: node.children ?? []) }
    }
    return result
}

private struct SpeakerEvidence {
    var participants: [Participant]
    var available: Bool
}

// Verified against a real two-person Chrome Meet with a separate prerecorded
// audio participant, 2026-09-26. AXDOMClassList carries the same dynamic speaking
// classes as the previous DOM reader; no browser scripting is involved.
private func chromeSpeakers(_ area: AXNode) -> SpeakerEvidence {
    guard let document = clean(area.documentId) else { return SpeakerEvidence(participants: [], available: false) }
    let nodes = walk(area)
    guard !nodes.contains(where: { $0.speakerIncomplete == true }) else { return SpeakerEvidence(participants: [], available: false) }
    guard nodes.filter({ $0.role == "AXWebArea" }).count == 1 else { return SpeakerEvidence(participants: [], available: false) }
    let hasClass: (AXNode, String) -> Bool = { ($0.classList ?? []).contains($1) }
    let microphoneMuted = nodes.contains { $0.role == "AXButton" && labels($0).contains { matches("^Turn on microphone(?: \\([^)]*\\))?$", $0) } } &&
        !nodes.contains { $0.role == "AXButton" && labels($0).contains { matches("^Turn off microphone(?: \\([^)]*\\))?$", $0) } }
    var selfNames = Set<String>()
    for list in nodes where list.role == "AXList" && labels(list).contains("Participants") {
        for row in list.children ?? [] where row.role == "AXGroup" {
            if let name = clean(row.description), name.count <= 100,
               walk(row).contains(where: { $0.role == "AXStaticText" && clean($0.value) == "(You)" }) { selfNames.insert(name) }
        }
    }
    let selfName = selfNames.count == 1 ? selfNames.first : nil
    guard selfNames.count <= 1, selfName != nil || microphoneMuted else { return SpeakerEvidence(participants: [], available: false) }
    struct Tile { var identity: String; var name: String; var speaking: Bool }
    var tiles: [Tile] = []
    var boundActiveSignals = Set<String>()
    let isSpeakingSignal: (AXNode) -> Bool = { node in
        node.role == "AXGroup" && hasClass(node, "DYfzY") && hasClass(node, "cYKTje") &&
            ["Oaajhc", "HX2H7", "wEsLMd", "OgVli"].contains { hasClass(node, $0) }
    }
    for tile in nodes where tile.role == "AXGroup" && hasClass(tile, "oZRSLe") {
        guard let identity = clean(tile.identifier) else { continue }
        let contents = walk(tile)
        guard contents.filter({ $0.role == "AXGroup" && hasClass($0, "oZRSLe") }).count == 1 else { continue }
        let slots = contents.filter { $0.role == "AXGroup" && hasClass($0, "XEazBc") && hasClass($0, "adnwBd") }
        guard slots.count == 1 else { continue }
        let names = walk(slots[0]).filter { $0.role == "AXStaticText" }.compactMap { clean($0.value) }
        guard names.count == 1, let name = names.first, name.count <= 100 else { continue }
        let signals = contents.filter { $0.role == "AXGroup" && hasClass($0, "DYfzY") && hasClass($0, "cYKTje") }
        guard signals.count <= 1 else { continue }
        let speaking = signals.contains(where: isSpeakingSignal)
        for signal in signals where isSpeakingSignal(signal) {
            if let signalID = clean(signal.identifier) { boundActiveSignals.insert(signalID) }
        }
        tiles.append(Tile(identity: identity, name: name, speaking: speaking))
    }
    guard !tiles.isEmpty, tiles.count <= 100, Set(tiles.map { $0.identity }).count == tiles.count else {
        return SpeakerEvidence(participants: [], available: false)
    }
    // An active badge with no validated participant owner can be an overlapping
    // unknown speaker. Do not silently discard it and confidently name another.
    guard nodes.filter(isSpeakingSignal).allSatisfy({ node in
        guard let identity = clean(node.identifier) else { return false }
        return boundActiveSignals.contains(identity)
    }), !tiles.contains(where: { tile in
        tile.speaking && tile.name == selfName && tiles.filter({ $0.name == tile.name }).count > 1
    }) else { return SpeakerEvidence(participants: [], available: false) }
    let participants = tiles.compactMap { tile -> Participant? in
        // Display names alone cannot disambiguate which duplicate is "You".
        if tile.name == selfName && tiles.filter({ $0.name == tile.name }).count > 1 { return nil }
        // With no self identity, a muted local microphone establishes only that
        // an actively speaking tile is remote. Do not invent the rest of a roster.
        if selfName == nil && !tile.speaking { return nil }
        let isSelf = tile.name == selfName
        let identity = [document, tile.identity, tile.name, isSelf ? "self" : "remote"].joined(separator: "\u{0}")
        let hash = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        return Participant(id: "ax-" + hash, name: tile.name, self: isSelf, speaking: tile.speaking)
    }
    return SpeakerEvidence(participants: participants, available: true)
}

private func analyze(_ tree: BrowserTree) -> Probe {
    let browser = tree.browser
    guard tree.running else { return Probe(state: "idle", detail: "Browser is not running.", browser: browser, absenceConfirmed: true) }
    guard let root = tree.root else { return Probe(state: "unavailable", detail: "Browser Accessibility tree is unavailable; meeting detection and names are paused.", browser: browser) }
    let nodes = walk(root)
    guard nodes.count <= maxNodes else {
        return Probe(state: "unavailable", detail: "Browser Accessibility inspection exceeded its limit; meeting detection and names are paused.", browser: browser)
    }
    var uncertainty: String? = nodes.contains(where: { $0.incomplete == true })
        ? "Browser Accessibility inspection was incomplete." : nil
    let scaffold = browserScaffold(root)
    let windows = browserScaffold(root, stopAtWindows: true).filter { $0.role == "AXWindow" }
    guard !windows.isEmpty else {
        if let uncertainty { return Probe(state: "unavailable", detail: uncertainty + " Meeting detection and names are paused.", browser: browser) }
        if tree.offscreenWindows == true {
            return Probe(state: "unavailable", detail: "Browser windows are on another desktop or in full screen. Meeting detection and names are paused.", browser: browser)
        }
        return Probe(state: "idle", detail: "Browser has no open windows.", browser: browser, absenceConfirmed: true)
    }
    let webAreas = scaffold.filter { $0.role == "AXWebArea" }
    if !webAreas.allSatisfy({ clean($0.url) != nil }) {
        uncertainty = uncertainty ?? "A browser page does not expose its address through Accessibility."
    }
    // Only a complete window can establish positive call state. An incomplete
    // different window must suppress names, not erase that observed call.
    let calls = windows.flatMap { window -> [(AXNode, String, Bool)] in
        let contents = walk(window)
        let complete = contents.count <= maxNodes && !contents.contains { $0.incomplete == true }
        return browserScaffold(window).compactMap { area in
            guard area.role == "AXWebArea", let path = meetPath(area.url) else { return nil }
            return (area, path, complete)
        }
    }
    let tabs = scaffold.filter { $0.role == "AXRadioButton" || $0.role == "AXTab" }
    let meetTabs = tabs.filter { tab in
        meetPath(tab.url) != nil || labels(tab).contains { matches("\\b[a-z]{3}-[a-z]{4}-[a-z]{3}\\b", $0) }
    }
    // Browsers commonly omit background tab contents from AX. A hidden Meet tab
    // could be another active call; it must not become "left" or a named speaker.
    if meetTabs.count > calls.count {
        uncertainty = uncertainty ?? "A Google Meet tab is not exposed through Accessibility. Bring that tab into view."
    }
    // A split view or browser sidebar can expose multiple pages in one window;
    // its extra web area must not hide a different window's unreadable content.
    if !windows.allSatisfy({ window in browserScaffold(window).contains { $0.role == "AXWebArea" } }) {
        uncertainty = uncertainty ?? "A browser window does not expose its page through Accessibility."
    }
    if calls.isEmpty {
        if let uncertainty { return Probe(state: "unavailable", detail: uncertainty + " Meeting detection and names are paused.", browser: browser) }
        // Tab titles are useful discovery hints, not authoritative proof that a
        // previously joined meeting ended (custom/hidden tabs can omit them).
        return Probe(state: "idle", detail: "No visible Google Meet call found.", browser: browser, absenceConfirmed: false)
    }
    var joined: [Snapshot] = []
    var namesAvailable = false
    var explicitNonCalls = 0
    for (area, path, complete) in calls {
        guard complete else { continue }
        let contents = walk(area)
        let inCall = contents.contains { node in
            node.role == "AXButton" && labels(node).contains { matches("^Leave call(?: \\([^)]*\\))?$", $0) }
        }
        let notJoined = contents.contains { node in
            (node.role == "AXButton" && labels(node).contains { ["Join now", "Ask to join", "Rejoin"].contains($0) }) ||
            (["AXStaticText", "AXHeading"].contains(node.role) && labels(node).contains { ["You left the meeting", "You've left the meeting", "You have left the meeting"].contains($0) })
        }
        if inCall && notJoined { return Probe(state: "unavailable", detail: "Google Meet Accessibility shows conflicting call states; waiting for a stable page.", browser: browser) }
        if inCall {
            let evidence = browser == "chrome" ? chromeSpeakers(area) : SpeakerEvidence(participants: [], available: false)
            namesAvailable = evidence.available
            joined.append(Snapshot(meeting: path, joined: true, participants: evidence.participants))
        } else if notJoined { explicitNonCalls += 1 }
        else { uncertainty = uncertainty ?? "A Google Meet page is visible but its call state is not readable." }
    }
    guard joined.count <= 1 else { return Probe(state: "ambiguous", detail: "Multiple joined Google Meet calls; keep only the call you want to record open.", browser: browser) }
    if var snapshot = joined.first {
        if let uncertainty {
            snapshot.participants = []
            return Probe(state: "unavailable", detail: "Meet detected; speaker names are paused. " + uncertainty, browser: browser, snapshot: snapshot)
        }
        let remote = snapshot.participants.filter { !$0.`self` && $0.speaking }
        let detail = remote.count == 1 ? "Meet hint: \(remote[0].name)" : remote.count > 1 ? "Meet connected · overlapping speakers" : namesAvailable ? "Meet connected · waiting for a speaker signal" : browser == "chrome" ? "Meet detected · open Meet’s People panel to identify your tile, or mute your microphone for remote speaker names" : "Meet detected · speaker names currently require Google Chrome"
        return Probe(state: "connected", detail: detail, browser: browser, snapshot: snapshot)
    }
    if let uncertainty { return Probe(state: "unavailable", detail: uncertainty + " Meeting detection and names are paused.", browser: browser) }
    return Probe(state: "idle", detail: "Google Meet is at the join or departure screen.", browser: browser, absenceConfirmed: explicitNonCalls == calls.count)
}

private func aggregate(_ probes: [Probe]) -> Probe {
    if probes.contains(where: { $0.state == "ambiguous" }) || probes.filter({ $0.snapshot?.joined == true }).count > 1 {
        return Probe(state: "ambiguous", detail: "Multiple Google Meet calls detected; names are paused.")
    }
    if let blocked = probes.first(where: { !["idle", "connected"].contains($0.state) }) {
        // Positive call state and confident attribution are separate. Unknown
        // browser activity can contaminate mixed audio, so never carry names.
        if blocked.state != "permission", let active = probes.first(where: { $0.snapshot?.joined == true }), var snapshot = active.snapshot {
            snapshot.participants = []
            return Probe(state: "unavailable", detail: "Meet detected; speaker names are paused until all browser windows can be checked.", browser: active.browser, snapshot: snapshot)
        }
        return blocked
    }
    if let connected = probes.first(where: { $0.state == "connected" }) { return connected }
    return Probe(state: "idle", detail: "Join a Google Meet call to check speaker names.", absenceConfirmed: probes.allSatisfy { $0.absenceConfirmed == true })
}

private final class AXReader {
    private var remaining = maxNodes
    private let deadline: TimeInterval
    private var visited: [CFHashCode: [AXUIElement]] = [:]
    private var failures = 0
    private var speakerFailures = 0
    private let readsSpeakerMetadata: Bool

    init(deadline: TimeInterval, readsSpeakerMetadata: Bool) {
        self.deadline = deadline
        self.readsSpeakerMetadata = readsSpeakerMetadata
    }

    private func read(_ element: AXUIElement, _ attribute: String, speakerOnly: Bool = false) -> CFTypeRef? {
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            if speakerOnly { speakerFailures += 1 } else { failures += 1 }
            return nil
        }
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        if error == .success { return value }
        if ![AXError.attributeUnsupported, .noValue].contains(error) {
            if speakerOnly { speakerFailures += 1 } else { failures += 1 }
        }
        return nil
    }
    private func text(_ value: CFTypeRef?) -> String? {
        if let url = value as? URL { return clean(url.absoluteString) }
        if let text = value as? String { return clean(text) }
        return nil
    }
    private func childElements(_ element: AXUIElement) -> [AXUIElement] {
        guard ProcessInfo.processInfo.systemUptime < deadline else { failures += 1; return [] }
        var count = 0
        let status = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
        if status == .attributeUnsupported || status == .noValue { return [] }
        guard status == .success, count <= maxChildren else { failures += 1; return [] }
        if count == 0 { return [] }
        guard ProcessInfo.processInfo.systemUptime < deadline else { failures += 1; return [] }
        var children: CFArray?
        let error = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, count, &children)
        guard error == .success, let values = children as? [AXUIElement] else { failures += 1; return [] }
        return values
    }

    func node(_ element: AXUIElement, depth: Int = 0, insideMeet: Bool = false) -> AXNode {
        guard remaining > 0, depth <= maxDepth, ProcessInfo.processInfo.systemUptime < deadline else {
            failures += 1; return AXNode(role: "AXUnknown", incomplete: true)
        }
        remaining -= 1
        let failuresBefore = failures
        let speakerFailuresBefore = speakerFailures
        let identity = CFHash(element)
        // A repeated object can be a browser AX alias, so skip its descendants.
        guard !(visited[identity] ?? []).contains(where: { CFEqual($0, element) }) else { return AXNode(role: "AXAlias") }
        visited[identity, default: []].append(element)
        guard let role = text(read(element, kAXRoleAttribute)) else { failures += 1; return AXNode(role: "AXUnknown", incomplete: true) }
        var output = AXNode(role: role)
        if role == "AXWebArea" {
            output.url = text(read(element, kAXURLAttribute))
            // Never descend into other websites or read their text fields.
            guard meetPath(output.url) != nil else {
                if failures > failuresBefore { output.incomplete = true }
                return output
            }
            var pid: pid_t = 0
            if AXUIElementGetPid(element, &pid) == .success {
                output.documentId = "ax-\(pid)-\(CFHash(element))"
            }
        }
        let isMeet = insideMeet || (role == "AXWebArea" && meetPath(output.url) != nil)
        if isMeet || role == "AXRadioButton" || role == "AXTab" {
            output.title = text(read(element, kAXTitleAttribute))
            output.description = text(read(element, kAXDescriptionAttribute))
            if isMeet {
                output.help = text(read(element, kAXHelpAttribute))
                // Only Chrome group nodes participate in the validated tile adapter.
                // Avoid several optional cross-process calls on every text/button.
                if readsSpeakerMetadata && role == "AXGroup" {
                    let nodeID = read(element, "ChromeAXNodeId", speakerOnly: true)
                    if let value = text(nodeID) ?? (nodeID as? NSNumber)?.stringValue { output.identifier = "chrome-" + value }
                    else { output.identifier = text(read(element, "AXDOMIdentifier", speakerOnly: true)) }
                    if let classes = read(element, "AXDOMClassList", speakerOnly: true) as? [String], classes.count <= 30 {
                        output.classList = classes.filter { $0.count <= 128 }.compactMap(clean)
                    }
                }
                // Text-only values, never inspect an editable control's contents.
                if ["AXStaticText", "AXHeading"].contains(role) { output.value = text(read(element, kAXValueAttribute)) }
            }
        }
        output.children = childElements(element).map { node($0, depth: depth + 1, insideMeet: isMeet) }
        if failures > failuresBefore { output.incomplete = true }
        if speakerFailures > speakerFailuresBefore { output.speakerIncomplete = true }
        return output
    }

    func application(_ element: AXUIElement) -> AXNode {
        guard let windows = read(element, kAXWindowsAttribute) as? [AXUIElement], windows.count <= 20 else {
            failures += 1; return AXNode(role: "AXApplication", incomplete: true)
        }
        return AXNode(role: "AXApplication", children: windows.map { node($0) })
    }
}

private func liveTree(_ browser: String, deadline: TimeInterval) -> BrowserTree {
    let bundle = browser == "chrome" ? "com.google.Chrome" : "com.apple.Safari"
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated }
    guard !apps.isEmpty else { return BrowserTree(browser: browser, running: false) }
    guard apps.count <= 4 else { return BrowserTree(browser: browser, running: true) }
    let reader = AXReader(deadline: deadline, readsSpeakerMetadata: browser == "chrome")
    let roots = apps.map { reader.application(AXUIElementCreateApplication($0.processIdentifier)) }
    let root = AXNode(role: "AXApplication", children: roots)
    // Owner, layer, size and alpha need no Screen Recording permission; titles do and are not read.
    let pids = Set(apps.map { $0.processIdentifier })
    let offscreen = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []).contains { window in
        guard let owner = window[kCGWindowOwnerPID as String] as? pid_t, pids.contains(owner),
              (window[kCGWindowLayer as String] as? Int) == 0, (window[kCGWindowIsOnscreen as String] as? Bool) != true,
              (window[kCGWindowAlpha as String] as? Double ?? 1) > 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Double] else { return false }
        return (bounds["Width"] ?? 0) >= 320 && (bounds["Height"] ?? 0) >= 240
    }
    return BrowserTree(browser: browser, running: true, root: root, offscreenWindows: offscreen)
}

private func emit(_ probe: Probe) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    if let data = try? encoder.encode(probe) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
}

private func argument(_ name: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

private let args = Array(CommandLine.arguments.dropFirst())
private let mode = argument("--browser", in: args) ?? "auto"
private let allowed = ["--browser", "--fixture", "--dump-tree", "--request-permission", "--check-permission", "--status"]
private let knownValues = [argument("--browser", in: args), argument("--fixture", in: args), argument("--dump-tree", in: args)].compactMap { $0 }
guard ["auto", "chrome", "safari"].contains(mode), args.allSatisfy({ allowed.contains($0) || knownValues.contains($0) }),
      !args.contains("--browser") || argument("--browser", in: args) != nil,
      !args.contains("--fixture") || argument("--fixture", in: args) != nil,
      !args.contains("--dump-tree") || argument("--dump-tree", in: args) != nil else {
    emit(Probe(state: "unavailable", detail: "Usage: seashell-meeting-accessibility [--browser auto|chrome|safari] [--check-permission|--request-permission] [--fixture FILE]")); exit(2)
}

if let file = argument("--fixture", in: args) {
    // No AX calls or permissions when replaying sanitized fixtures.
    do {
        let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: file))
        defer { try? handle.close() }
        guard let data = try handle.read(upToCount: 2 * 1024 * 1024 + 1), data.count <= 2 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        guard fixture.browsers.count <= 2,
              Set(fixture.browsers.map { $0.browser }).count == fixture.browsers.count,
              fixture.browsers.allSatisfy({ ["chrome", "safari"].contains($0.browser) }) else { throw CocoaError(.fileReadCorruptFile) }
        let selected = fixture.browsers.filter { mode == "auto" || $0.browser == mode }
        guard !selected.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
        emit(aggregate(selected.map(analyze)))
    } catch { emit(Probe(state: "unavailable", detail: "Invalid or oversized Accessibility fixture.")); exit(2) }
    exit(0)
}

// Only an explicit setup command may ask macOS to show its permission prompt.
private let trusted = args.contains("--request-permission")
    ? AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    : AXIsProcessTrusted()
if !trusted { emit(Probe(state: "permission", detail: permissionHelp, accessibilityTrusted: false)); exit(0) }
if args.contains("--check-permission") || args.contains("--request-permission") || args.contains("--status") {
    emit(Probe(state: "idle", detail: "Accessibility is enabled. Join a Google Meet call to check speaker names.", accessibilityTrusted: true)); exit(0)
}
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.075)
private let browsers = mode == "auto" ? ["chrome", "safari"] : [mode]
// Reserve time for each running browser within the original whole-read budget.
// A busy first browser must not hand the next one an already expired deadline.
private let runningBrowsers = Set(browsers.filter { browser in
    let bundle = browser == "chrome" ? "com.google.Chrome" : "com.apple.Safari"
    return NSRunningApplication.runningApplications(withBundleIdentifier: bundle).contains { !$0.isTerminated }
})
private let deadline = ProcessInfo.processInfo.systemUptime + 0.60
private var remainingBrowsers = runningBrowsers.count
private let trees = browsers.map { browser in
    let now = ProcessInfo.processInfo.systemUptime
    let budget = max(0, deadline - now) / Double(max(1, remainingBrowsers))
    if runningBrowsers.contains(browser) { remainingBrowsers -= 1 }
    return liveTree(browser, deadline: min(deadline, now + budget))
}
if let path = argument("--dump-tree", in: args) {
    // Explicit developer diagnostics only. Production probing never saves UI
    // trees. Remove unrelated browser tab titles/URLs before writing locally.
    func scoped(_ node: AXNode, insideMeet: Bool = false) -> AXNode {
        var result = node
        let meet = insideMeet || meetPath(node.url) != nil
        if !meet {
            if node.role == "AXWebArea" { result.url = "https://example.invalid/" }
            if ["AXRadioButton", "AXTab"].contains(node.role), !labels(node).contains(where: { $0.hasPrefix("Meet") || $0.hasPrefix("Google Meet") }) {
                result.title = "Other tab"; result.description = nil; result.help = nil; result.value = nil
            }
        }
        result.children = node.children?.map { scoped($0, insideMeet: meet) }
        return result
    }
    let safeTrees = trees.map { BrowserTree(browser: $0.browser, running: $0.running, root: $0.root.map { scoped($0) }, offscreenWindows: $0.offscreenWindows) }
    if let data = try? JSONEncoder().encode(Fixture(browsers: safeTrees)) {
        if !FileManager.default.createFile(atPath: path, contents: data, attributes: [.posixPermissions: 0o600]) {
            emit(Probe(state: "unavailable", detail: "Could not save the requested local Accessibility diagnostic.")); exit(2)
        }
    }
}
private var result = aggregate(trees.map(analyze))
result.accessibilityTrusted = true
emit(result)
