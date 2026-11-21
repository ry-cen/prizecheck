import UIKit
import Capacitor

/// The packaged app's bridge. It registers the local `NativeSignIn` plugin, which the
/// Capacitor CLI does not discover because it is part of this target.
final class PrizecheckBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeSignInPlugin())
    }
}
