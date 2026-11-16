import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import Security
import UIKit

// Opt-in native sign-in for nonprod gateways: ASWebAuthenticationSession with PKCE, a
// one-time code exchanged for a short-lived `collection:read` credential kept in the
// Keychain, and a native-only Collection read. JavaScript never sees the credential.
//
// This file logs nothing: no URLs, codes, verifiers, tokens or response bodies.

/// Where the gateway is. Empty or invalid means "not configured": the fixture demo runs.
enum GatewayConfiguration {
    static let infoKey = "PrizecheckGatewayOrigin"
    static let launchArgument = "PrizecheckGatewayOrigin"

    /// Info.plist value, or in a DEBUG build a loopback launch-argument override.
    static func resolve() -> URL? {
        #if DEBUG
        let arguments = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        if let override = arguments[launchArgument] as? String {
            return parse(override, allowLoopbackHTTP: true, loopbackOnly: true)
        }
        #endif
        guard let value = Bundle.main.object(forInfoDictionaryKey: infoKey) as? String else {
            return nil
        }
        #if DEBUG
        let allowLoopbackHTTP = true
        #else
        let allowLoopbackHTTP = false
        #endif
        return parse(value, allowLoopbackHTTP: allowLoopbackHTTP, loopbackOnly: false)
    }

    /// An origin only: scheme, host and optional port. No path, query, fragment or userinfo.
    static func parse(_ value: String, allowLoopbackHTTP: Bool, loopbackOnly: Bool) -> URL? {
        guard !value.isEmpty,
              let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            return nil
        }
        let loopback = host == "127.0.0.1" || host == "localhost"
        switch scheme {
        case "https":
            if loopbackOnly { return nil }
        case "http":
            guard allowLoopbackHTTP, loopback, components.port != nil else { return nil }
        default:
            return nil
        }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = components.port
        return origin.url
    }
}

enum NativeSignInFormats {
    static let callbackScheme = "prizecheck-native"
    static let tokenPattern = "^[A-Za-z0-9_-]{43}$"

    static func isToken(_ value: String) -> Bool {
        return value.range(of: tokenPattern, options: .regularExpression) != nil
    }

    static func base64URL(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func randomBytes(_ count: Int) -> Data? {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { return nil }
        return Data(bytes)
    }

    static func challenge(for verifier: String) -> String {
        return base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    enum Callback: Equatable {
        case code(String)
        case denied
        case invalid
    }

    /// Strict: scheme, host `auth`, path `/callback`, and either `code`+`state` or
    /// `error`+`state`, each exactly once, with the state this attempt created.
    static func parseCallback(_ url: URL, expectedState: String) -> Callback {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == callbackScheme,
              components.host == "auth",
              components.path == "/callback",
              components.port == nil,
              components.user == nil, components.password == nil,
              components.fragment == nil,
              let items = components.queryItems else {
            return .invalid
        }
        var values: [String: String] = [:]
        for item in items {
            guard let value = item.value, values[item.name] == nil else { return .invalid }
            values[item.name] = value
        }
        guard values.count == items.count, values["state"] == expectedState else { return .invalid }
        if values.count == 2, let code = values["code"], isToken(code) {
            return .code(code)
        }
        if values.count == 2, values["error"] == "access_denied" {
            return .denied
        }
        return .invalid
    }

    static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}

/// Every redirect is refused: the 3xx answer is returned as the response and treated as a failure.
private final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

private final class PresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    private weak var plugin: NativeSignInPlugin?

    init(plugin: NativeSignInPlugin) {
        self.plugin = plugin
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return plugin?.presentationWindow() ?? ASPresentationAnchor()
    }
}

@objc(NativeSignInPlugin)
public final class NativeSignInPlugin: CAPInstancePlugin, CAPBridgedPlugin {
    public let identifier = "NativeSignInPlugin"
    public let jsName = "NativeSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "collection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise)
    ]

    @objc override public func load() {
        NativeCredentialStore.purgeLeftoverCredentialsOnFirstLoad()
    }

    private static let requestTimeout: TimeInterval = 15
    private static let maxBody = 4 * 1024 * 1024
    private static let maxCursor = 2048

    private lazy var gateway: URL? = GatewayConfiguration.resolve()
    private lazy var store: NativeCredentialStore? = self.gateway.map { NativeCredentialStore(account: $0.absoluteString) }
    private lazy var presentation = PresentationContext(plugin: self)
    private lazy var urlSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = NativeSignInPlugin.requestTimeout
        configuration.timeoutIntervalForResource = NativeSignInPlugin.requestTimeout
        return URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil)
    }()

    // Touched on the main queue only.
    private var signInPending = false
    private var authSession: ASWebAuthenticationSession?

    // MARK: Plugin methods

    @objc func status(_ call: CAPPluginCall) {
        onMainFromPackagedApp(call) {
            guard self.gateway != nil else {
                call.resolve(["configured": false, "signedIn": false])
                return
            }
            call.resolve(["configured": true, "signedIn": self.currentCredential() != nil])
        }
    }

    @objc func signIn(_ call: CAPPluginCall) {
        onMainFromPackagedApp(call) {
            self.beginSignIn(call)
        }
    }

    @objc func collection(_ call: CAPPluginCall) {
        let cursor = call.getString("cursor")
        onMainFromPackagedApp(call) {
            self.readCollection(cursor: cursor, call: call)
        }
    }

    @objc func signOut(_ call: CAPPluginCall) {
        onMainFromPackagedApp(call) {
            self.endSession(call)
        }
    }

    // MARK: Guards

    /// Every method runs on the main queue and only for the packaged origin.
    private func onMainFromPackagedApp(_ call: CAPPluginCall, _ work: @escaping () -> Void) {
        DispatchQueue.main.async {
            guard self.isPackagedOrigin() else {
                call.reject("Not available", "UNAVAILABLE")
                return
            }
            work()
        }
    }

    private func isPackagedOrigin() -> Bool {
        guard let url = bridge?.webView?.url,
              url.scheme?.lowercased() == "capacitor",
              url.host?.lowercased() == "localhost" else {
            return false
        }
        return true
    }

    fileprivate func presentationWindow() -> ASPresentationAnchor? {
        return bridge?.webView?.window
    }

    private func currentCredential() -> NativeCredential? {
        guard let store = store, let credential = store.load() else { return nil }
        if credential.isExpired() {
            store.delete()
            return nil
        }
        return credential
    }

    // MARK: Sign in

    private func beginSignIn(_ call: CAPPluginCall) {
        guard let origin = gateway, !signInPending,
              let verifierBytes = NativeSignInFormats.randomBytes(32),
              let stateBytes = NativeSignInFormats.randomBytes(32) else {
            call.resolve(["result": "error"])
            return
        }
        let verifier = NativeSignInFormats.base64URL(verifierBytes)
        let state = NativeSignInFormats.base64URL(stateBytes)
        guard var start = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            call.resolve(["result": "error"])
            return
        }
        start.path = "/auth/native/start"
        start.queryItems = [
            URLQueryItem(name: "challenge", value: NativeSignInFormats.challenge(for: verifier)),
            URLQueryItem(name: "state", value: state)
        ]
        guard let startURL = start.url else {
            call.resolve(["result": "error"])
            return
        }
        signInPending = true
        let session = ASWebAuthenticationSession(
            url: startURL,
            callbackURLScheme: NativeSignInFormats.callbackScheme
        ) { [weak self] callbackURL, error in
            DispatchQueue.main.async {
                self?.finishBrowser(callbackURL: callbackURL, error: error, verifier: verifier, state: state, origin: origin, call: call)
            }
        }
        session.prefersEphemeralWebBrowserSession = true
        session.presentationContextProvider = presentation
        authSession = session
        if !session.start() {
            authSession = nil
            signInPending = false
            call.resolve(["result": "error"])
        }
    }

    private func finishBrowser(
        callbackURL: URL?,
        error: Error?,
        verifier: String,
        state: String,
        origin: URL,
        call: CAPPluginCall
    ) {
        authSession = nil
        if let error = error {
            signInPending = false
            let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
            call.resolve(["result": cancelled ? "cancelled" : "error"])
            return
        }
        guard let callbackURL = callbackURL else {
            signInPending = false
            call.resolve(["result": "error"])
            return
        }
        switch NativeSignInFormats.parseCallback(callbackURL, expectedState: state) {
        case .denied:
            signInPending = false
            call.resolve(["result": "cancelled"])
        case .invalid:
            signInPending = false
            call.resolve(["result": "error"])
        case .code(let code):
            exchange(code: code, verifier: verifier, origin: origin, call: call)
        }
    }

    private func exchange(code: String, verifier: String, origin: URL, call: CAPPluginCall) {
        func finish(_ result: String) {
            DispatchQueue.main.async {
                self.signInPending = false
                call.resolve(["result": result])
            }
        }
        guard let url = endpoint(origin, "/auth/native/token", query: nil),
              let body = try? JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier]) else {
            finish("error")
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        send(request) { status, data in
            guard status == 200, let data = data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = object["token"] as? String, NativeSignInFormats.isToken(token),
                  let expires = (object["expires_at"] as? String).flatMap(NativeSignInFormats.parseDate),
                  expires > Date() else {
                finish("error")
                return
            }
            DispatchQueue.main.async {
                let saved = self.store?.save(NativeCredential(token: token, expiresAt: expires)) ?? false
                self.signInPending = false
                call.resolve(["result": saved ? "signed-in" : "error"])
            }
        }
    }

    // MARK: Collection

    private func readCollection(cursor: String?, call: CAPPluginCall) {
        guard let origin = gateway, let credential = currentCredential() else {
            call.resolve(["kind": "signed-out"])
            return
        }
        var query: String?
        if let cursor = cursor {
            var allowed = CharacterSet.alphanumerics
            allowed.insert(charactersIn: "-._~")
            guard !cursor.isEmpty, cursor.count <= NativeSignInPlugin.maxCursor,
                  let encoded = cursor.addingPercentEncoding(withAllowedCharacters: allowed) else {
                call.resolve(["kind": "unavailable"])
                return
            }
            query = "cursor=" + encoded
        }
        guard let url = endpoint(origin, "/api/collection", query: query) else {
            call.resolve(["kind": "unavailable"])
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer " + credential.token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        send(request) { status, data in
            DispatchQueue.main.async {
                if status == 401 {
                    self.store?.delete(ifToken: credential.token)
                    call.resolve(["kind": "signed-out"])
                    return
                }
                guard status == 200, let data = data,
                      let page = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      page["entries"] is [Any] else {
                    call.resolve(["kind": "unavailable"])
                    return
                }
                call.resolve(["kind": "page", "page": page])
            }
        }
    }

    // MARK: Sign out

    /// The credential is removed on this device first, so sign-out cannot be defeated by a
    /// slow or unreachable gateway. The server-side revoke is then best effort.
    private func endSession(_ call: CAPPluginCall) {
        let token = store?.load()?.token
        store?.delete()
        guard let origin = gateway, let token = token,
              let url = endpoint(origin, "/auth/native/sign-out", query: nil) else {
            call.resolve()
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        send(request) { _, _ in
            DispatchQueue.main.async {
                call.resolve()
            }
        }
    }

    // MARK: Transport

    private func endpoint(_ origin: URL, _ path: String, query: String?) -> URL? {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return nil }
        components.path = path
        components.percentEncodedQuery = query
        return components.url
    }

    /// Completion gets the HTTP status and body, or nil, nil on a transport failure or an
    /// oversized body. Redirects are refused by the session delegate.
    private func send(_ request: URLRequest, completion: @escaping (Int?, Data?) -> Void) {
        var request = request
        request.httpShouldHandleCookies = false
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = NativeSignInPlugin.requestTimeout
        urlSession.dataTask(with: request) { data, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else {
                completion(nil, nil)
                return
            }
            if let data = data, data.count > NativeSignInPlugin.maxBody {
                completion(nil, nil)
                return
            }
            completion(http.statusCode, data)
        }.resume()
    }
}
