import UIKit
import Capacitor

/// Apps built with the iOS 27 SDK must use the scene life cycle or UIKit kills
/// them at launch. The window comes from `UISceneStoryboardFile` (Main) in
/// Info.plist; URL opens arrive here instead of on the app delegate, and the
/// proxy reposts them as the notifications Capacitor plugins listen for.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

}
