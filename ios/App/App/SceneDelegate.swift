import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        // Cold start from a home-screen quick action. Plugins have not loaded
        // yet, so (like Capacitor does for launch URLs) wait for the first
        // capacitorViewDidAppear before handing it over; the App plugin then
        // keeps the appUrlOpen event until the web app's listener attaches.
        if let item = connectionOptions.shortcutItem {
            var token: NSObjectProtocol?
            token = NotificationCenter.default.addObserver(forName: .capacitorViewDidAppear, object: nil, queue: .main) { _ in
                if let token { NotificationCenter.default.removeObserver(token) }
                _ = self.openQuickAction(item)
            }
        }
    }

    // Quick action tapped while the app is already running (or suspended).
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(openQuickAction(shortcutItem))
    }

    // Forward the shortcut to the web app as an ivy:// URL open, exactly as
    // if iOS had opened that link: Capacitor's App plugin turns the
    // notification into its `appUrlOpen` event (src/components/NativeUrlOpens.jsx).
    // The url lives in the item's userInfo (Info.plist); the type is the
    // fallback, e.g. ai.joinivy.app.new-booking → ivy://action/new-booking.
    @discardableResult
    private func openQuickAction(_ item: UIApplicationShortcutItem) -> Bool {
        let fromInfo = item.userInfo?["url"] as? String
        let fromType = item.type.hasPrefix("ai.joinivy.app.")
            ? "ivy://action/" + String(item.type.dropFirst("ai.joinivy.app.".count))
            : nil
        guard let urlString = fromInfo ?? fromType, let url = URL(string: urlString), url.scheme == "ivy" else {
            return false
        }
        NotificationCenter.default.post(name: .capacitorOpenURL, object: [
            "url": url,
            "options": [UIApplication.OpenURLOptionsKey: Any]()
        ])
        return true
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
