import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import Security
import UIKit
import os

// Opt-in native sign-in for nonprod gateways: ASWebAuthenticationSession with PKCE, a
// one-time code exchanged for a short-lived `collection:read` credential kept in the
// Keychain, and a native-only Collection read. JavaScript never sees the credential.
//
// This file logs nothing in a release build. A DEBUG build writes only the fixed stage labels
// and integer codes of `NativeStage` below: no URLs, codes, verifiers, tokens or response bodies.

/// DEBUG-only diagnostics for the simulator job: one line per stage, a fixed label with at most
/// one integer. Every value is a case of these enums or an `Int`; nothing else can be logged.
enum NativeStage: String {
    case signinBegin = "signin_begin"
    case signinStartFailed = "signin_start_failed"
    case browserError = "browser_error"
    case callbackMissing = "callback_missing"
    case callbackInvalid = "callback_invalid"
    case callbackDenied = "callback_denied"
    case callbackCode = "callback_code"
    case tokenTransportFailed = "token_transport_failed"
    case tokenHTTP = "token_http"
    case tokenBodyInvalid = "token_body_invalid"
    case keychainSave = "keychain_save"
    case signinResolved = "signin_resolved"
    case collectionNoCredential = "collection_no_credential"
    case collectionTransportFailed = "collection_transport_failed"
    case collectionHTTP = "collection_http"
    case collectionBodyInvalid = "collection_body_invalid"
    case collectionPage = "collection_page"
    case signoutBegin = "signout_begin"
    case revokeHTTP = "revoke_http"
    case revokeTransportFailed = "revoke_transport_failed"

    /// The name of the one integer a stage may carry.
    enum Field: String {
        case code
        case nsurl
        case status
    }

    #if DEBUG
    private static let logger = Logger(subsystem: "app.prizecheck.prototype", category: "native-stage")
    #endif

    func log() {
        #if DEBUG
        NativeStage.logger.notice("\(self.rawValue, privacy: .public)")
        #endif
    }

    func log(_ field: Field, _ value: Int) {
        #if DEBUG
        NativeStage.logger.notice("\(self.rawValue, privacy: .public) \(field.rawValue, privacy: .public)=\(value, privacy: .public)")
        #endif
    }

    func log(result: SignInResult) {
        #if DEBUG
        NativeStage.logger.notice("\(self.rawValue, privacy: .public) result=\(result.rawValue, privacy: .public)")
        #endif
    }
}

/// The three values `signIn` resolves with.
enum SignInResult: String {
    case signedIn = "signed-in"
    case cancelled
    case error
}

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
        // A pending revocation is retried whenever the app becomes active, cold launch included. The observer covers
        // activations from here on; the async check covers a plugin that loaded after the app was already active.
        // While the device is unlocked the Keychain is readable. No timer, no background task.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        DispatchQueue.main.async {
            if UIApplication.shared.applicationState == .active {
                self.revokePending()
            }
        }
    }

    @objc private func appDidBecomeActive() {
        revokePending()
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
    /// Bumped by every sign-in start and every sign-out, so an exchange that finishes after a sign-out can tell it is stale.
    private var signInGeneration = 0
    private var revocationPassRunning = false
    private var authSession: ASWebAuthenticationSession?

    // MARK: Plugin methods

    @objc func status(_ call: CAPPluginCall) {
        onMainFromPackagedApp(call) {
            guard self.gateway != nil else {
                call.resolve(["configured": false, "signedIn": false])
                return
            }
            // A credential pending revocation is not signed in: `credential()` never returns one.
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
        guard let store = store, let credential = store.credential() else { return nil }
        if credential.isExpired() {
            store.drop(ifToken: credential.token)
            return nil
        }
        return credential
    }

    // MARK: Sign in

    private func resolveSignIn(_ call: CAPPluginCall, _ result: SignInResult) {
        NativeStage.signinResolved.log(result: result)
        call.resolve(["result": result.rawValue])
    }

    private func beginSignIn(_ call: CAPPluginCall) {
        NativeStage.signinBegin.log()
        guard let origin = gateway, !signInPending,
              let verifierBytes = NativeSignInFormats.randomBytes(32),
              let stateBytes = NativeSignInFormats.randomBytes(32) else {
            NativeStage.signinStartFailed.log()
            resolveSignIn(call, .error)
            return
        }
        // A retry of earlier sign-outs; it neither delays nor blocks this sign-in.
        revokePending()
        let verifier = NativeSignInFormats.base64URL(verifierBytes)
        let state = NativeSignInFormats.base64URL(stateBytes)
        guard var start = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            NativeStage.signinStartFailed.log()
            resolveSignIn(call, .error)
            return
        }
        start.path = "/auth/native/start"
        start.queryItems = [
            URLQueryItem(name: "challenge", value: NativeSignInFormats.challenge(for: verifier)),
            URLQueryItem(name: "state", value: state)
        ]
        guard let startURL = start.url else {
            NativeStage.signinStartFailed.log()
            resolveSignIn(call, .error)
            return
        }
        signInPending = true
        signInGeneration += 1
        let generation = signInGeneration
        let session = ASWebAuthenticationSession(
            url: startURL,
            callbackURLScheme: NativeSignInFormats.callbackScheme
        ) { [weak self] callbackURL, error in
            DispatchQueue.main.async {
                self?.finishBrowser(callbackURL: callbackURL, error: error, verifier: verifier, state: state, origin: origin, generation: generation, call: call)
            }
        }
        session.prefersEphemeralWebBrowserSession = true
        session.presentationContextProvider = presentation
        authSession = session
        if !session.start() {
            authSession = nil
            signInPending = false
            NativeStage.signinStartFailed.log()
            resolveSignIn(call, .error)
        }
    }

    private func finishBrowser(
        callbackURL: URL?,
        error: Error?,
        verifier: String,
        state: String,
        origin: URL,
        generation: Int,
        call: CAPPluginCall
    ) {
        authSession = nil
        if let error = error {
            signInPending = false
            let browserError = error as? ASWebAuthenticationSessionError
            NativeStage.browserError.log(.code, browserError?.code.rawValue ?? -1)
            let cancelled = browserError?.code == .canceledLogin
            resolveSignIn(call, cancelled ? .cancelled : .error)
            return
        }
        guard let callbackURL = callbackURL else {
            signInPending = false
            NativeStage.callbackMissing.log()
            resolveSignIn(call, .error)
            return
        }
        switch NativeSignInFormats.parseCallback(callbackURL, expectedState: state) {
        case .denied:
            signInPending = false
            NativeStage.callbackDenied.log()
            resolveSignIn(call, .cancelled)
        case .invalid:
            signInPending = false
            NativeStage.callbackInvalid.log()
            resolveSignIn(call, .error)
        case .code(let code):
            NativeStage.callbackCode.log()
            exchange(code: code, verifier: verifier, origin: origin, generation: generation, call: call)
        }
    }

    private func exchange(code: String, verifier: String, origin: URL, generation: Int, call: CAPPluginCall) {
        func finish(_ result: SignInResult) {
            DispatchQueue.main.async {
                self.signInPending = false
                self.resolveSignIn(call, result)
            }
        }
        guard let url = endpoint(origin, "/auth/native/token", query: nil),
              let body = try? JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier]) else {
            finish(.error)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        send(request) { status, data, nsurlCode in
            if let status = status {
                NativeStage.tokenHTTP.log(.status, status)
            } else {
                NativeStage.tokenTransportFailed.log(.nsurl, nsurlCode ?? -1)
            }
            guard status == 200, let data = data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = object["token"] as? String, NativeSignInFormats.isToken(token),
                  let expires = (object["expires_at"] as? String).flatMap(NativeSignInFormats.parseDate),
                  expires > Date() else {
                if status == 200 { NativeStage.tokenBodyInvalid.log() }
                finish(.error)
                return
            }
            DispatchQueue.main.async {
                let credential = NativeCredential(token: token, expiresAt: expires)
                self.signInPending = false
                if generation != self.signInGeneration {
                    // A sign-out came first: this credential is never installed. It is queued for revocation, or, if
                    // the Keychain refuses, revoked once from memory.
                    let queued = self.store?.queueRevocation(credential) ?? false
                    if !queued {
                        self.sendRevocation(token) { _ in }
                    }
                    self.revokePending()
                    self.resolveSignIn(call, .cancelled)
                    return
                }
                let saved = self.store?.replace(with: credential) ?? false
                if !saved {
                    self.sendRevocation(token) { _ in }
                    self.resolveSignIn(call, .error)
                    return
                }
                // A credential this one displaced is now pending revocation.
                self.revokePending()
                self.resolveSignIn(call, .signedIn)
            }
        }
    }

    // MARK: Collection

    private func readCollection(cursor: String?, call: CAPPluginCall) {
        guard let origin = gateway, let credential = currentCredential() else {
            NativeStage.collectionNoCredential.log()
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
        send(request) { status, data, nsurlCode in
            DispatchQueue.main.async {
                if let status = status {
                    NativeStage.collectionHTTP.log(.status, status)
                } else {
                    NativeStage.collectionTransportFailed.log(.nsurl, nsurlCode ?? -1)
                }
                if status == 401 {
                    self.store?.drop(ifToken: credential.token)
                    call.resolve(["kind": "signed-out"])
                    return
                }
                guard status == 200, let data = data,
                      let page = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      page["entries"] is [Any] else {
                    if status == 200 { NativeStage.collectionBodyInvalid.log() }
                    call.resolve(["kind": "unavailable"])
                    return
                }
                NativeStage.collectionPage.log()
                call.resolve(["kind": "page", "page": page])
            }
        }
    }

    // MARK: Sign out

    /// Sign-out removes the readable credential on this device and records its pending revocation in ONE Keychain
    /// write, and resolves without waiting for the network; a slow or unreachable gateway cannot hold it up. The
    /// revocation is then sent, and retried on every app activation (cold launch included), on sign-out and on the next
    /// sign-in, until the gateway answers 204 or the credential's own expiry has passed. A pending credential is never
    /// used for a read, never reported as signed in, and never sent to another gateway origin (each origin has its own
    /// Keychain item). It resolves at once unless the Keychain refused both the update and the delete; then it rejects
    /// with `KEYCHAIN`, after still starting the revocation from memory. The web layer's existing `catch` ignores that
    /// rejection and shows signed out.
    ///
    /// | Event                                         | Result                                                        |
    /// | Killed before the Keychain write              | sign-out did not take; still signed in on relaunch            |
    /// | Killed after the write, before the request    | pending; the next activation sends it                         |
    /// | Server revoked, 204 lost                      | resent, 204 again, removed                                    |
    /// | Killed after the 204, before removal          | resent, 204, removed                                          |
    /// | An exchange finishes after sign-out           | its credential is never installed; it is queued for revocation |
    /// | Sign-out of A fails, B signs in               | reads use only B; A's token is sent only to sign-out          |
    /// | Several sign-outs fail                        | each is one entry; one 503 does not stop the others           |
    /// | App configured for another origin             | that origin's item is not read; retried when used again       |
    /// | Switch turned off                             | 404; stays pending, removed after an attempt past expiry      |
    /// | Device clock ahead                            | still attempted at least once before removal                  |
    ///
    /// Residual: the app is never opened again, or is deleted or reinstalled (the first-load purge drops pending
    /// entries); the Keychain refuses the update (one in-memory attempt only, and earlier pending entries are lost with
    /// the deleted item); the Keychain cannot be read (the item is deleted with no attempt to revoke it or its pending
    /// entries); the Keychain refuses the delete as well (the credential can reappear as signed in on relaunch, unless
    /// the in-memory attempt revoked it, in which case the first read is a 401 and removes it); the app stays in the
    /// foreground after a failed attempt (next try at the next activation, sign-in or sign-out). In each, the server
    /// credential ends at its 24-hour expiry.
    private func endSession(_ call: CAPPluginCall) {
        NativeStage.signoutBegin.log()
        signInGeneration += 1
        var retired: (removed: Bool, unqueued: NativeCredential?) = (removed: true, unqueued: nil)
        if let store = store {
            retired = store.retire()
        }
        if retired.removed {
            call.resolve()
        } else {
            call.reject("Sign-out incomplete", "KEYCHAIN")
        }
        if let unqueued = retired.unqueued {
            sendRevocation(unqueued.token) { _ in }
        }
        revokePending()
    }

    /// Sends every pending revocation, at most one pass at a time. Main queue only.
    private func revokePending() {
        guard !revocationPassRunning else { return }
        revocationPassRunning = true
        revokeNext(attempted: [])
    }

    /// Each pending token is sent once per pass, one at a time; a token queued during the pass is picked up by it.
    private func revokeNext(attempted: Set<String>) {
        guard let next = store?.pendingRevocations().first(where: { !attempted.contains($0.token) }) else {
            revocationPassRunning = false
            return
        }
        sendRevocation(next.token) { confirmed in
            if confirmed || next.isExpired() {
                self.store?.finishRevocation(token: next.token)
            }
            self.revokeNext(attempted: attempted.union([next.token]))
        }
    }

    /// Posts the sign-out for one token to the configured gateway. Only a 204 confirms: the gateway never answers 401
    /// here, so a 401, 404 or 3xx comes from an intermediary or a switched-off gateway and the token stays pending until
    /// its expiry. Always completes on the main queue, never synchronously.
    private func sendRevocation(_ token: String, completion: @escaping (Bool) -> Void) {
        guard let origin = gateway,
              let url = endpoint(origin, "/auth/native/sign-out", query: nil) else {
            DispatchQueue.main.async {
                completion(false)
            }
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        send(request) { status, _, nsurlCode in
            DispatchQueue.main.async {
                if let status = status {
                    NativeStage.revokeHTTP.log(.status, status)
                } else {
                    NativeStage.revokeTransportFailed.log(.nsurl, nsurlCode ?? -1)
                }
                completion(status == 204)
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
    /// oversized body. Redirects are refused by the session delegate. In a DEBUG build the third
    /// value is the `NSURLError` code of a transport failure (-1 for any other failure); it is
    /// always nil in a release build.
    private func send(_ request: URLRequest, completion: @escaping (Int?, Data?, Int?) -> Void) {
        var request = request
        request.httpShouldHandleCookies = false
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = NativeSignInPlugin.requestTimeout
        urlSession.dataTask(with: request) { data, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else {
                #if DEBUG
                let nsError = error as NSError?
                let code = nsError?.domain == NSURLErrorDomain ? nsError?.code : nil
                completion(nil, nil, code ?? -1)
                #else
                completion(nil, nil, nil)
                #endif
                return
            }
            if let data = data, data.count > NativeSignInPlugin.maxBody {
                #if DEBUG
                completion(nil, nil, -1)
                #else
                completion(nil, nil, nil)
                #endif
                return
            }
            completion(http.statusCode, data, nil)
        }.resume()
    }
}
