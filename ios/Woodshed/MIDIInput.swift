import CoreMIDI
import Foundation

/// Listens to every connected MIDI source (USB or Bluetooth) and reconnects when devices change.
/// Callbacks are delivered on the main thread, in the order the notes arrived.
final class MIDIInput: @unchecked Sendable {
    struct Message {
        let ticks: UInt64   // host time (mach_absolute_time units)
        let status: UInt8
        let data1: UInt8
        let data2: UInt8
    }
    var onMessages: (@MainActor ([Message]) -> Void)?
    var onDevicesChanged: (@MainActor ([String]) -> Void)?

    private var client = MIDIClientRef()
    private var port = MIDIPortRef()

    init() {
        MIDIClientCreateWithBlock("Woodshed" as CFString, &client) { [weak self] _ in
            self?.connectAll()
        }
        MIDIInputPortCreateWithProtocol(client, "Input" as CFString, ._1_0, &port) { [weak self] list, _ in
            self?.receive(list)
        }
        connectAll()
    }

    func sourceNames() -> [String] {
        (0..<MIDIGetNumberOfSources()).compactMap { i in
            var name: Unmanaged<CFString>?
            guard MIDIObjectGetStringProperty(MIDIGetSource(i), kMIDIPropertyDisplayName, &name) == noErr,
                  let value = name?.takeRetainedValue() as String?,
                  !value.contains("Network Session") else { return nil }
            return value
        }
    }

    private func connectAll() {
        for i in 0..<MIDIGetNumberOfSources() {
            let source = MIDIGetSource(i)
            MIDIPortDisconnectSource(port, source)
            MIDIPortConnectSource(port, source, nil)
        }
        let names = sourceNames()
        DispatchQueue.main.async {
            MainActor.assumeIsolated { self.onDevicesChanged?(names) }
        }
    }

    /// Words per Universal MIDI Packet, indexed by message type (top 4 bits of the first word).
    private static let umpSize = [1, 1, 1, 2, 2, 4, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4]

    private func receive(_ list: UnsafePointer<MIDIEventList>) {
        var messages: [Message] = []
        for packet in list.unsafeSequence() {
            let count = Int(packet.pointee.wordCount)
            let stamp = packet.pointee.timeStamp
            let ticks = stamp == 0 ? mach_absolute_time() : stamp
            withUnsafeBytes(of: packet.pointee.words) { raw in
                let words = raw.bindMemory(to: UInt32.self)
                var i = 0
                while i < min(count, words.count) {
                    let word = words[i]
                    let type = Int(word >> 28)
                    if type == 0x2 { // MIDI 1.0 channel voice: note on/off, controllers
                        messages.append(Message(ticks: ticks, status: UInt8((word >> 16) & 0xFF),
                                                data1: UInt8((word >> 8) & 0xFF), data2: UInt8(word & 0xFF)))
                    }
                    i += MIDIInput.umpSize[type]
                }
            }
        }
        guard !messages.isEmpty else { return }
        DispatchQueue.main.async {
            MainActor.assumeIsolated { self.onMessages?(messages) }
        }
    }
}
