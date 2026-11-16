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

    private func returnFromBrowser(_ label: String) {
        safari.links[label].tap()
        // iOS may ask for confirmation before opening a custom URL scheme.
        let open = safari.buttons["Open"]
        if open.waitForExistence(timeout: 3) { open.tap() }
        let systemOpen = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
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
        returnFromBrowser("Cancel sign-in")
        XCTAssertTrue(app.staticTexts["Sign-in cancelled."].waitForExistence(timeout: 15))
        openBrowser()
        returnFromBrowser("Simulate sign-in failure")
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
