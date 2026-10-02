// Seashell's calendar reader. Prints the events around now as a JSON array in
// the shape src/calendar.ts parses: titles, times, attendees and the meeting
// link found in the event's URL, location or notes. Notes are only searched
// for a link; they are never printed.
//
// Why native: scripting Calendar.app from the background watcher needs Apple
// Events permission that its hardened Bun host cannot hold, and it launches
// Calendar.app on every read. This helper uses EventKit, relaunches itself as
// its own responsible process (like seashell-microphone), and so holds its own
// Calendars permission. Reads never prompt; only --request-permission does.

import EventKit
import Darwin
import Foundation

private let disclaimedEnvironment = "SEASHELL_CALENDAR_RESPONSIBLE"
private let permissionExitCode: Int32 = 77
private let usage = "Usage: seashell-calendar [--lookback-minutes N] [--lead-minutes N] | --status | --request-permission [--no-disclaim]"

private func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

private func argument(_ name: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

private let arguments = Array(CommandLine.arguments.dropFirst())
do {
    let flags = ["--status", "--request-permission", "--no-disclaim"], valued = ["--lookback-minutes", "--lead-minutes"]
    var index = 0
    while index < arguments.count {
        if flags.contains(arguments[index]) { index += 1 }
        else if valued.contains(arguments[index]), index + 1 < arguments.count { index += 2 }
        else { fail(usage, code: 2) }
    }
}
private let lookbackMinutes = Double(argument("--lookback-minutes", in: arguments) ?? "10") ?? -1
private let leadMinutes = Double(argument("--lead-minutes", in: arguments) ?? "15") ?? -1
guard (0...1_440).contains(lookbackMinutes), (0...1_440).contains(leadMinutes) else { fail(usage, code: 2) }

// MARK: - Responsibility (kept in step with macos-microphone.swift)

private typealias DisclaimFunction = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

private func executablePath() -> String? {
    var size: UInt32 = 0
    _ = _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size) + 1)
    guard _NSGetExecutablePath(&buffer, &size) == 0 else { return nil }
    return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().path
}

private func relaunchResponsibleForItself() {
    guard getenv(disclaimedEnvironment) == nil, !arguments.contains("--no-disclaim"),
          let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
          let path = executablePath() else { return }
    let disclaim = unsafeBitCast(symbol, to: DisclaimFunction.self)
    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else { return }
    defer { posix_spawnattr_destroy(&attributes) }
    guard disclaim(&attributes, 1) == 0 else { return }
    setenv(disclaimedEnvironment, "1", 1)
    let argv: [UnsafeMutablePointer<CChar>?] = ([path] + arguments).map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    var child: pid_t = 0
    let status = posix_spawn(&child, path, nil, &attributes, argv, environ)
    unsetenv(disclaimedEnvironment)
    guard status == 0 else { return }
    var sources: [DispatchSourceSignal] = []
    for value in [SIGINT, SIGTERM, SIGHUP] {
        signal(value, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: value, queue: .global())
        source.setEventHandler { kill(child, value) }
        source.resume()
        sources.append(source)
    }
    var result: Int32 = 0
    while waitpid(child, &result, 0) == -1 && errno == EINTR {}
    sources.forEach { $0.cancel() }
    let terminatingSignal = result & 0x7f
    exit(terminatingSignal == 0 ? (result >> 8) & 0xff : 128 + terminatingSignal)
}

relaunchResponsibleForItself()

// MARK: - Permission

private let store = EKEventStore()

/// Raw values avoid the deprecated `.authorized` alias of `.fullAccess`.
private func authorizationName() -> String {
    switch EKEventStore.authorizationStatus(for: .event).rawValue {
    case 0: return "notDetermined"
    case 1: return "restricted"
    case 2: return "denied"
    case 3: return "authorized"
    case 4: return "writeOnly"
    default: return "unknown"
    }
}

private func printJSON(_ value: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) else { exit(1) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

private func statusReport() -> [String: Any] {
    var report: [String: Any] = [
        "authorization": authorizationName(),
        "responsibleForItself": getenv(disclaimedEnvironment) != nil,
        "executable": executablePath() ?? CommandLine.arguments[0],
    ]
    if authorizationName() == "authorized" { report["calendars"] = store.calendars(for: .event).count }
    return report
}

if arguments.contains("--status") { printJSON(statusReport()); exit(0) }
if arguments.contains("--request-permission") {
    if authorizationName() == "notDetermined" {
        let answered = DispatchSemaphore(value: 0)
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { _, _ in answered.signal() }
        } else {
            store.requestAccess(to: .event) { _, _ in answered.signal() }
        }
        answered.wait()
    }
    printJSON(statusReport())
    exit(authorizationName() == "authorized" ? 0 : permissionExitCode)
}

// MARK: - Events

guard authorizationName() == "authorized" else {
    fail("Calendar access is off for Seashell Calendar. Run: seashell meeting calendar setup", code: permissionExitCode)
}

private let linkPattern = try! NSRegularExpression(pattern:
    #"https://(?:meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}|(?:[\w-]+\.)?zoom\.us/[jw]/[\w?=&.-]+|teams\.microsoft\.com/l/meetup-join/[^\s<>"]+)"#)

/// The first conferencing link in the event's own URL, then location, then notes.
private func joinURL(_ event: EKEvent) -> String {
    for text in [event.url?.absoluteString, event.location, event.notes].compactMap({ $0 }) {
        let range = NSRange(text.startIndex..., in: text)
        if let match = linkPattern.firstMatch(in: text, range: range), let found = Range(match.range, in: text) {
            return String(text[found])
        }
    }
    return ""
}

private func response(_ status: EKParticipantStatus) -> String {
    switch status {
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .pending: return "pending"
    default: return "unknown"
    }
}

private let iso = ISO8601DateFormatter()
private let now = Date()
private let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-lookbackMinutes * 60),
                                                 end: now.addingTimeInterval(leadMinutes * 60), calendars: nil)
private let rows: [[String: Any]] = store.events(matching: predicate)
    .filter { !$0.isAllDay && $0.status != .canceled }
    .map { event in
        let attendees: [[String: String]] = (event.attendees ?? []).compactMap { person in
            let email = person.url.scheme == "mailto" ? String(person.url.absoluteString.dropFirst("mailto:".count)) : ""
            let name = person.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !name.isEmpty || !email.isEmpty else { return nil }
            return ["name": name.isEmpty ? email : name, "email": email, "response": response(person.participantStatus)]
        }
        return [
            "provider": "macos-eventkit",
            "eventId": event.calendarItemExternalIdentifier ?? event.eventIdentifier ?? UUID().uuidString,
            "calendar": event.calendar?.title ?? "",
            "title": (event.title?.isEmpty == false ? event.title! : "Meeting"),
            "startAt": iso.string(from: event.startDate),
            "endAt": iso.string(from: event.endDate),
            "location": event.location ?? "",
            "joinUrl": joinURL(event),
            "attendees": attendees,
        ]
    }
printJSON(rows)
