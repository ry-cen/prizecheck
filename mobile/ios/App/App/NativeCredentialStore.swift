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

/// One Keychain generic-password item per gateway origin.
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

    func load() -> NativeCredential? {
        var query = identity
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(NativeCredential.self, from: data)
    }

    @discardableResult
    func save(_ credential: NativeCredential) -> Bool {
        guard let data = try? JSONEncoder().encode(credential) else { return false }
        delete()
        var item = identity
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    func delete() {
        SecItemDelete(identity as CFDictionary)
    }

    /// Deletes the stored credential only if it is still the one that was used, so a late
    /// 401 for an old token cannot remove a newer sign-in.
    func delete(ifToken token: String) {
        if let stored = load(), stored.token == token {
            delete()
        }
    }
}
