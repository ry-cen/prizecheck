import XCTest

// Exercises the packaged WKWebView, AppLauncher, Mobile Safari and Capacitor's scene bridge.
// No injected JavaScript, fake native plugins, real accounts or network fixture listener.
final class FixtureUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.prizecheck.prototype")
    let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")

    override func setUpWithError() throws {
        continueAfterFailure = false
        safari.terminate()
        app.launch()
        let ready = NSPredicate { _, _ in
            self.app.buttons["Sign out"].exists || self.app.buttons["Sign in with browser"].exists || self.app.buttons["Cancel sign-in"].exists
        }
        expectation(for: ready, evaluatedWith: app)
        waitForExpectations(timeout: 45)
        if app.buttons["Sign out"].exists {
            app.buttons["Sign out"].tap()
        }
        if app.buttons["Cancel sign-in"].exists {
            app.buttons["Cancel sign-in"].tap()
        }
        XCTAssertTrue(app.buttons["Sign in with browser"].waitForExistence(timeout: 15))
    }

    private func openBrowser() {
        app.buttons["Sign in with browser"].tap()
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 20))
        XCTAssertTrue(safari.links["Continue to sample Collection"].waitForExistence(timeout: 45))
    }

    private func returnFromBrowser(_ label: String, awaitPrompt: Bool = false) {
        safari.links[label].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if awaitPrompt {
            // iOS may ask "Open in app?" for the custom URL scheme, and on a slow runner the prompt can
            // appear well after a fixed 3 s window. Poll on the test's own (main) thread for at most 20 s:
            // tap an Open button only once it is hittable (Safari's first, then SpringBoard's). When
            // nothing is hittable, block up to 1 s (or the time left) in the app's own foreground wait,
            // which returns early once the app is in the foreground and otherwise holds the full wait
            // instead of re-querying or sleeping. A timeout is not a failure here; the foreground
            // assertion below reports the real one.
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline {
                let safariOpen = safari.buttons["Open"]
                let springboardOpen = springboard.buttons["Open"]
                if safariOpen.exists && safariOpen.isHittable {
                    safariOpen.tap()
                    break
                }
                if springboardOpen.exists && springboardOpen.isHittable {
                    springboardOpen.tap()
                    break
                }
                let t = min(1, deadline.timeIntervalSinceNow)
                if t > 0, app.wait(for: .runningForeground, timeout: t) { break }
            }
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
            return
        }
        // iOS may ask for confirmation before opening a custom URL scheme.
        let open = safari.buttons["Open"]
        if open.waitForExistence(timeout: 3) { open.tap() }
        let systemOpen = springboard.buttons["Open"]
        if systemOpen.exists { systemOpen.tap() }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
    }

    func testWarmBrowserReturnRecoveryAndSignOut() {
        openBrowser()
        returnFromBrowser("Continue to sample Collection")
        XCTAssertTrue(app.buttons["Sign out"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Pikachu, Unspecified Variant"].waitForExistence(timeout: 10))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Sign out"].waitForExistence(timeout: 15))
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.buttons["Sign in with browser"].waitForExistence(timeout: 10))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Sign in with browser"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Sign out"].exists)
    }

    func testColdBrowserReturn() {
        openBrowser()
        app.terminate()
        XCTAssertEqual(app.state, .notRunning)
        returnFromBrowser("Continue to sample Collection")
        XCTAssertTrue(app.buttons["Sign out"].waitForExistence(timeout: 15))
    }

    func testBrowserCancellationAndError() {
        openBrowser()
        returnFromBrowser("Cancel sign-in", awaitPrompt: true)
        XCTAssertTrue(app.staticTexts["Sign-in cancelled."].waitForExistence(timeout: 15))
        openBrowser()
        returnFromBrowser("Simulate sign-in failure", awaitPrompt: true)
        XCTAssertTrue(app.staticTexts["Unable to sign in. Please try again."].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Sign out"].exists)
    }

    func testAppCancellationAfterNativeResume() {
        openBrowser()
        app.activate() // Real appStateChange through the scene lifecycle, not a mocked listener.
        XCTAssertTrue(app.buttons["Cancel sign-in"].waitForExistence(timeout: 10))
        app.buttons["Cancel sign-in"].tap()
        XCTAssertTrue(app.staticTexts["Sign-in cancelled."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Sign in with browser"].exists)
    }

    func testCollectionShowMoreAndRefresh() {
        openBrowser()
        returnFromBrowser("Continue to sample Collection")
        XCTAssertTrue(app.buttons["Pikachu, Unspecified Variant"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Mew, Unspecified Variant"].exists)
        app.buttons["Show more"].tap()
        XCTAssertTrue(app.buttons["Mew, Unspecified Variant"].waitForExistence(timeout: 10))
        app.buttons["Refresh"].tap()
        XCTAssertTrue(app.buttons["Show more"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Pikachu, Unspecified Variant"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Mew, Unspecified Variant"].exists)
    }
}

// The opt-in native sign-in, against the loopback stub on 127.0.0.1:4320 (mobile/native-fixture.mjs).
// The launch argument is honoured only by Debug builds, and only for a loopback origin.
// Sample data only: no real account, credential or gateway.
// The "Auth" prefix makes this class sort before FixtureUITests, so XCTest runs it first.
final class AuthNativeSignInUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.prizecheck.prototype")
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let authSheet = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
    let firstCard = "Bulbasaur, Unspecified Variant"

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["-PrizecheckGatewayOrigin", "http://127.0.0.1:4320"]
    }

    override func tearDownWithError() throws {
        app.terminate()
    }

    func testNativeSignInRestoreAndSignOut() {
        app.launch()
        XCTAssertTrue(app.buttons["Sign in"].waitForExistence(timeout: 45))
        app.buttons["Sign in"].tap()
        // iOS asks before opening the sign-in sheet; an ephemeral session may skip the alert.
        let confirm = springboard.buttons["Continue"]
        if confirm.waitForExistence(timeout: 10) { confirm.tap() }
        // The sheet is remote Safari content; look for Allow where the system exposes it.
        let allowed = NSPredicate { _, _ in
            self.app.webViews.buttons["Allow"].exists || self.authSheet.buttons["Allow"].exists || self.app.buttons["Allow"].exists
        }
        expectation(for: allowed, evaluatedWith: app)
        waitForExpectations(timeout: 60)
        for candidate in [app.webViews.buttons["Allow"], authSheet.buttons["Allow"], app.buttons["Allow"]] where candidate.exists {
            candidate.tap()
            break
        }
        let firstCardAppeared = app.buttons[firstCard].waitForExistence(timeout: 30)
        if !firstCardAppeared { reportFinalState() }
        XCTAssertTrue(firstCardAppeared)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons[firstCard].waitForExistence(timeout: 30))
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.buttons["Sign in"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons[firstCard].exists)
    }

    /// Diagnostics only: names the state the app was left in when the first card did not appear.
    /// Fixed labels, nothing read from the page beyond whether a known string exists.
    private func reportFinalState() {
        let states: [(String, Bool)] = [
            ("unable_to_sign_in", app.staticTexts["Unable to sign in. Please try again."].exists),
            ("signin_cancelled", app.staticTexts["Sign-in cancelled."].exists),
            ("session_ended", app.staticTexts["Your session ended. Sign in again."].exists),
            ("collection_error", app.staticTexts["Couldn't load your Collection. Try again."].exists),
            ("loading", app.staticTexts["Loading your Collection…"].exists),
            ("sign_in_button", app.buttons["Sign in"].exists)
        ]
        let label = states.first(where: { $0.1 })?.0 ?? "unknown"
        print("native-ui-state=\(label)")
        print("native-auth-sheet=\(authSheet.state == .runningForeground ? "foreground" : "not_foreground")")
    }
}
