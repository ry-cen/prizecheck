import Foundation
import Security

/// The device credential for the native sign-in: a short-lived, `collection:read` bearer token.
/// It lives only in the iOS Keychain and never reaches JavaScript.
struct NativeCredential: Codable, Equatable {
    let token: String
    let expiresAt: Date

    func isExpired(now: Date = Date()) -> Bool {
        return expiresAt <= now
    }
}

/// One Keychain generic-password item per gateway origin, holding everything kept for that origin: the readable
/// credential and the credentials whose server-side revocation is still pending. Called from the main queue only.
///
/// Invariants (the residual cases are listed in mobile/NATIVE_SIGN_IN_IOS.md):
/// - A credential moves from "readable" to "pending revocation" in ONE Keychain update, so after a crash it is in exactly
///   one of the two. The item is never deleted before it is written.
/// - A pending credential is never returned by `credential()`, so it is never used for a read and never counts as signed in.
/// - A pending credential leaves the item only through `finishRevocation(token:)`, which the caller invokes after a 204
///   or an attempt at or past its expiry.
/// - A Keychain read that fails for any reason but "not found" or "undecodable" gives nil, and no method writes after it.
final class NativeCredentialStore {
    static let service = "app.prizecheck.native-credential"

    /// UserDefaults is wiped when the app is deleted, but Keychain items are not. This flag is
    /// therefore absent on the first run after an install or reinstall.
    static let installMarkerKey = "nativeSignIn.installMarker"

    /// On the first load after an install, removes every native credential left in the Keychain
    /// by an earlier install (any gateway origin), then records the marker. Keychain attributes
    /// of new items are unchanged. Logs nothing.
    static func purgeLeftoverCredentialsOnFirstLoad(defaults: UserDefaults = .standard) {
        if defaults.bool(forKey: installMarkerKey) { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        let status = SecItemDelete(query as CFDictionary)
        // Only mark the install as handled once the sweep succeeded (or found nothing).
        if status == errSecSuccess || status == errSecItemNotFound {
            defaults.set(true, forKey: installMarkerKey)
        }
    }

    /// Everything kept for one gateway origin, in one Keychain item, so a credential moves to the
    /// revocation list in a single atomic update: after a crash it is in exactly one of the two.
    private struct Record: Codable {
        var credential: NativeCredential?
        var revoking: [NativeCredential]

        var isEmpty: Bool {
            return credential == nil && revoking.isEmpty
        }
    }

    private let account: String

    init(account: String) {
        self.account = account
    }

    private var identity: [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: NativeCredentialStore.service,
            kSecAttrAccount as String: account
        ]
    }

    /// Not found, or data that does not decode (an item in an older format), gives an empty record. Any other
    /// Keychain error gives nil, and callers must not write after nil.
    private func read() -> Record? {
        var query = identity
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return Record(credential: nil, revoking: [])
        }
        guard status == errSecSuccess else { return nil }
        if let data = item as? Data, let record = try? JSONDecoder().decode(Record.self, from: data) {
            return record
        }
        return Record(credential: nil, revoking: [])
    }

    /// An empty record deletes the item (true when it was deleted or not there). Otherwise the item is updated in
    /// place, or added when there is none; it is never deleted first.
    private func write(_ record: Record) -> Bool {
        if record.isEmpty {
            return deleteItem()
        }
        guard let data = try? JSONEncoder().encode(record) else { return false }
        let update: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(identity as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = identity
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        NativeStage.keychainSave.log(.status, Int(status))
        return status == errSecSuccess
    }

    private func deleteItem() -> Bool {
        let status = SecItemDelete(identity as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    /// The readable credential. A credential pending revocation is never returned.
    func credential() -> NativeCredential? {
        if let record = read() {
            return record.credential
        }
        return nil
    }

    /// Stores `credential` as the readable one. A live credential with a different token is moved to the revocation
    /// list in the same write. False when the Keychain could not be read or written.
    func replace(with credential: NativeCredential) -> Bool {
        guard var record = read() else { return false }
        if let existing = record.credential, existing.token != credential.token {
            record.revoking.append(existing)
        }
        record.credential = credential
        return write(record)
    }

    /// Sign-out on this device: moves the live credential to the revocation list in one write.
    /// - `(true, nil)`: removed, and queued when there was one (or there was nothing live).
    /// - If the item cannot be read, it is deleted: `(deleted, nil)`.
    /// - If the write fails, the item is deleted (local sign-out wins) and the credential is returned in `unqueued`, so
    ///   the caller can try once from memory: `(deleted, credential)`.
    /// `deleted` is true for a successful delete or an item that was not there.
    func retire() -> (removed: Bool, unqueued: NativeCredential?) {
        guard var record = read() else {
            return (deleteItem(), nil)
        }
        guard let live = record.credential else {
            return (true, nil)
        }
        record.revoking.append(live)
        record.credential = nil
        if write(record) {
            return (true, nil)
        }
        return (deleteItem(), live)
    }

    /// Adds `credential` to the revocation list without touching the readable one. False when the Keychain could not
    /// be read or written.
    func queueRevocation(_ credential: NativeCredential) -> Bool {
        guard var record = read() else { return false }
        if !record.revoking.contains(where: { $0.token == credential.token }) {
            record.revoking.append(credential)
        }
        return write(record)
    }

    /// Clears the readable credential only if it is still the one that was used, so a late 401 for an old token
    /// cannot remove a newer sign-in. The revocation list is left alone.
    func drop(ifToken token: String) {
        guard var record = read() else { return }
        if let stored = record.credential, stored.token == token {
            record.credential = nil
            _ = write(record)
        }
    }

    func pendingRevocations() -> [NativeCredential] {
        if let record = read() {
            return record.revoking
        }
        return []
    }

    /// Removes that token from the revocation list.
    func finishRevocation(token: String) {
        guard var record = read() else { return }
        let remaining = record.revoking.filter { $0.token != token }
        if remaining.count != record.revoking.count {
            record.revoking = remaining
            _ = write(record)
        }
    }
}
