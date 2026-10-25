use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime,
    WebviewWindow, Window, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ICON_ID: &str = "2api-console-tray";
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_CONNECT_ID: &str = "tray-connect";
const TRAY_MONITOR_ID: &str = "tray-monitor";
const TRAY_QUIT_ID: &str = "tray-quit";

pub(crate) fn is_background_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    args.into_iter().skip(1).any(|arg| arg.as_ref() == "--background")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TrayLabels {
    show: &'static str,
    connect: &'static str,
    monitor: &'static str,
    quit: &'static str,
    tooltip: &'static str,
}

fn tray_labels(locale: &str) -> Result<TrayLabels, &'static str> {
    match locale {
        "en" => Ok(TrayLabels {
            show: "Show Main Window", connect: "Back to Connections", monitor: "Usage Monitor",
            quit: "Quit Usage Ledger", tooltip: "Usage Ledger",
        }),
        "zh" => Ok(TrayLabels {
            show: "显示主窗口", connect: "返回连接页", monitor: "全局用量监控",
            quit: "退出用量账本", tooltip: "用量账本",
        }),
        _ => Err("Unsupported desktop locale"),
    }
}

fn tray_menu<R: Runtime>(app: &AppHandle<R>, labels: TrayLabels) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, TRAY_SHOW_ID, labels.show, true, None::<&str>)?;
    let connect = MenuItem::with_id(app, TRAY_CONNECT_ID, labels.connect, true, None::<&str>)?;
    let monitor = MenuItem::with_id(app, TRAY_MONITOR_ID, labels.monitor, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &monitor, &connect, &quit])
}

#[tauri::command]
pub fn set_desktop_locale<R: Runtime>(app: AppHandle<R>, locale: String) -> Result<(), String> {
    let labels = tray_labels(&locale)?;
    let tray = app.tray_by_id(TRAY_ICON_ID).ok_or("Desktop tray unavailable")?;
    let menu = tray_menu(&app, labels).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(labels.tooltip)).map_err(|error| error.to_string())?;
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.set_title(labels.tooltip).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum TrayMenuAction {
    ShowMainWindow,
    GoToConnect,
    GoToMonitor,
    QuitApplication,
}

fn tray_menu_action(menu_id: &str) -> Option<TrayMenuAction> {
    match menu_id {
        TRAY_SHOW_ID => Some(TrayMenuAction::ShowMainWindow),
        TRAY_CONNECT_ID => Some(TrayMenuAction::GoToConnect),
        TRAY_MONITOR_ID => Some(TrayMenuAction::GoToMonitor),
        TRAY_QUIT_ID => Some(TrayMenuAction::QuitApplication),
        _ => None,
    }
}

fn recovery_bounds(
    bounds: PhysicalRect<i32, u32>,
    work_areas: &[PhysicalRect<i32, u32>],
    default_inner_size: PhysicalSize<u32>,
    minimum_inner_size: PhysicalSize<u32>,
    frame: PhysicalSize<u32>,
) -> Option<PhysicalRect<i32, u32>> {
    let to_outer = |inner: PhysicalSize<u32>| PhysicalSize::new(
        inner.width.saturating_add(frame.width), inner.height.saturating_add(frame.height),
    );
    let default_size = to_outer(default_inner_size);
    let minimum_size = to_outer(minimum_inner_size);
    let intersects = |area: &&PhysicalRect<i32, u32>| {
        i64::from(bounds.position.x) < i64::from(area.position.x) + i64::from(area.size.width)
            && i64::from(area.position.x) < i64::from(bounds.position.x) + i64::from(bounds.size.width)
            && i64::from(bounds.position.y) < i64::from(area.position.y) + i64::from(area.size.height)
            && i64::from(area.position.y) < i64::from(bounds.position.y) + i64::from(bounds.size.height)
    };
    let visible_area = work_areas.iter().find(intersects);
    let invalid_size = bounds.size.width < minimum_size.width || bounds.size.height < minimum_size.height;
    if visible_area.is_some() && !invalid_size {
        return None;
    }
    let area = visible_area.or_else(|| work_areas.first())?;
    let size = if invalid_size { default_size } else { bounds.size };
    let size = PhysicalSize::new(size.width.min(area.size.width), size.height.min(area.size.height));
    Some(PhysicalRect {
        position: PhysicalPosition::new(
            area.position.x + ((area.size.width - size.width) / 2) as i32,
            area.position.y + ((area.size.height - size.height) / 2) as i32,
        ),
        size,
    })
}

fn frame_size(outer: PhysicalSize<u32>, inner: PhysicalSize<u32>) -> PhysicalSize<u32> {
    PhysicalSize::new(outer.width.saturating_sub(inner.width), outer.height.saturating_sub(inner.height))
}

fn inner_size_for_outer(outer: PhysicalSize<u32>, frame: PhysicalSize<u32>) -> PhysicalSize<u32> {
    PhysicalSize::new(outer.width.saturating_sub(frame.width), outer.height.saturating_sub(frame.height))
}

fn recover_main_window_bounds<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let bounds = PhysicalRect { position: window.outer_position()?, size: window.outer_size()? };
    let mut frame = frame_size(bounds.size, window.inner_size()?);
    let config = window.app_handle().config().app.windows.iter()
        .find(|config| config.label == MAIN_WINDOW_LABEL).ok_or(tauri::Error::WindowNotFound)?;
    let scale = window.scale_factor()?;
    let maximized = window.is_maximized()?;
    let fullscreen = window.is_fullscreen()?;
    let normal_minimum = LogicalSize::new(config.min_width.unwrap_or(1.), config.min_height.unwrap_or(1.)).to_physical(scale);
    let minimum = if maximized || fullscreen { PhysicalSize::new(1, 1) } else { normal_minimum };
    let areas: Vec<_> = window.available_monitors()?.iter().map(|monitor| *monitor.work_area()).collect();
    let default_size = LogicalSize::new(config.width, config.height).to_physical(scale);
    if let Some(mut recovered) = recovery_bounds(bounds, &areas, default_size, minimum, frame) {
        if fullscreen { window.set_fullscreen(false)?; }
        if maximized { window.unmaximize()?; }
        if fullscreen || maximized {
            // Normal windows can have a different non-client frame than fullscreen/maximized ones.
            frame = frame_size(window.outer_size()?, window.inner_size()?);
            let Some(normal_bounds) = recovery_bounds(bounds, &areas, default_size, normal_minimum, frame) else { return Ok(()); };
            recovered = normal_bounds;
        }
        window.set_size(inner_size_for_outer(recovered.size, frame))?;
        window.set_position(recovered.position)?;
    }
    Ok(())
}

pub(crate) fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.unminimize()?;
        window.show()?;
        recover_main_window_bounds(&window)?;
        window.set_focus()?;
    }
    Ok(())
}

/// 主窗口导航到指定 hash 路由(前端 SPA 路由)。用于托盘"返回连接页"等快捷导航。
fn navigate_main_window<R: Runtime>(app: &AppHandle<R>, hash: &str) -> tauri::Result<()> {
    show_main_window(app)?;
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        // eval 在 WebView2 执行 JS,改 location.hash 触发 SPA 路由(不刷页面)
        window.eval(format!("window.location.hash = '{hash}'"))?;
    }
    Ok(())
}

pub fn setup_desktop_shell<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    // The webview applies its saved locale after loading; use English until then.
    let labels = tray_labels("en").expect("English tray labels are defined");
    let menu = tray_menu(app.handle(), labels)?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .tooltip(labels.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match tray_menu_action(event.id().as_ref()) {
            Some(TrayMenuAction::ShowMainWindow) => {
                if let Err(error) = show_main_window(app) {
                    eprintln!("failed to show main window from tray: {error}");
                }
            }
            Some(TrayMenuAction::GoToConnect) => {
                if let Err(error) = navigate_main_window(app, "#/connect") {
                    eprintln!("failed to navigate to connect page: {error}");
                }
            }
            Some(TrayMenuAction::GoToMonitor) => {
                if let Err(error) = navigate_main_window(app, "#/usage-monitor") {
                    eprintln!("failed to open usage monitor: {error}");
                }
            }
            Some(TrayMenuAction::QuitApplication) => app.exit(0),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(error) = show_main_window(tray.app_handle()) {
                    eprintln!("failed to show main window from tray click: {error}");
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn handle_main_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Err(error) = window.hide() {
                eprintln!("failed to hide main window to tray: {error}");
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_launch_requires_an_exact_argument_after_the_executable() {
        assert!(is_background_launch(["console2api.exe", "--background"]));
        assert!(is_background_launch(["console2api.exe", "--other", "--background"]));
        assert!(!is_background_launch(["--background"]));
        assert!(!is_background_launch(std::iter::empty::<&str>()));
        for arg in ["--background=1", "--background-task", "-background", "--Background", "C:\\--background\\console2api.exe"] {
            assert!(!is_background_launch(["console2api.exe", arg]), "{arg}");
        }
    }

    #[test]
    fn background_launch_accepts_native_os_arguments_without_lossy_conversion() {
        let args = [std::ffi::OsString::from("console2api.exe"), std::ffi::OsString::from("--background")];
        assert!(is_background_launch(args));
        assert!(!is_background_launch(["console2api.exe"]));
    }

    #[test]
    fn startup_and_second_instance_share_the_background_visibility_guard() {
        let source = include_str!("main.rs");
        assert!(source.contains("let background_launch = is_background_launch(std::env::args_os());"));
        let second_instance = source.split("tauri_plugin_single_instance::init(").nth(1).unwrap()
            .split(".manage(").next().unwrap();
        assert!(second_instance.contains("if is_background_launch(args) {"));
        assert!(second_instance.contains("return;"));
        assert!(second_instance.contains("show_main_window(app)"));
        let setup = source.split(".setup(move |app| {").nth(1).unwrap()
            .split(".build(tauri::generate_context!())").next().unwrap();
        assert!(setup.contains("if !background_launch {"));
        assert!(setup.contains("show_main_window(app.handle())"));
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = config["app"]["windows"].as_array().unwrap().iter()
            .find(|window| window["label"] == "main").unwrap();
        assert_eq!(window["visible"], false);
        assert_eq!(window["focus"], false);
    }

    #[test]
    fn tray_captions_follow_supported_locales_without_changing_action_ids() {
        let english = tray_labels("en").unwrap();
        assert_eq!(english.show, "Show Main Window");
        assert_eq!(english.connect, "Back to Connections");
        assert_eq!(english.monitor, "Usage Monitor");
        assert_eq!(english.quit, "Quit Usage Ledger");
        assert_eq!(english.tooltip, "Usage Ledger");
        let chinese = tray_labels("zh").unwrap();
        assert_eq!(chinese.show, "显示主窗口");
        assert_eq!(chinese.connect, "返回连接页");
        assert_eq!(chinese.monitor, "全局用量监控");
        assert_eq!(chinese.quit, "退出用量账本");
        assert_eq!(chinese.tooltip, "用量账本");
        assert!(tray_labels("fr").is_err());
        assert_eq!(tray_menu_action(TRAY_MONITOR_ID), Some(TrayMenuAction::GoToMonitor));
    }

    #[test]
    fn tray_menu_exposes_show_and_explicit_quit_actions() {
        assert_eq!(
            tray_menu_action(TRAY_SHOW_ID),
            Some(TrayMenuAction::ShowMainWindow)
        );
        assert_eq!(
            tray_menu_action(TRAY_QUIT_ID),
            Some(TrayMenuAction::QuitApplication)
        );
        assert_eq!(tray_menu_action("unknown"), None);
        assert_eq!(tray_menu_action(TRAY_CONNECT_ID), Some(TrayMenuAction::GoToConnect));
        assert_eq!(tray_menu_action(TRAY_MONITOR_ID), Some(TrayMenuAction::GoToMonitor));
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect { position: PhysicalPosition::new(x, y), size: PhysicalSize::new(width, height) }
    }

    #[test]
    fn restore_repairs_minimized_sentinel_and_invalid_size_without_moving_healthy_windows() {
        let area = rect(0, 0, 1920, 1040);
        let defaults = PhysicalSize::new(1600, 980);
        let minimum = PhysicalSize::new(1180, 720);
        let frame = PhysicalSize::new(0, 0);
        let sentinel = recovery_bounds(rect(-32000, -32000, 160, 28), &[area], defaults, minimum, frame).unwrap();
        assert_eq!(sentinel.position, PhysicalPosition::new(160, 30));
        assert_eq!(sentinel.size, defaults);
        let invalid = recovery_bounds(rect(100, 100, 160, 28), &[area], defaults, minimum, frame).unwrap();
        assert_eq!(invalid.size, defaults);
        assert!(recovery_bounds(rect(70, 20, 1400, 900), &[area], defaults, minimum, frame).is_none());
        assert!(recovery_bounds(rect(-100, 20, 1400, 900), &[area], defaults, minimum, frame).is_none());

        let frame = frame_size(PhysicalSize::new(1616, 996), defaults);
        let small_area = rect(0, 0, 1600, 1000);
        let recovered = recovery_bounds(rect(-32000, -32000, 160, 28), &[small_area], defaults, minimum, frame).unwrap();
        let applied_inner = inner_size_for_outer(recovered.size, frame);
        assert_eq!(applied_inner, PhysicalSize::new(1584, 980));
        assert_eq!(PhysicalSize::new(applied_inner.width + frame.width, applied_inner.height + frame.height), recovered.size);
        assert!(recovered.position.x + recovered.size.width as i32 <= small_area.position.x + small_area.size.width as i32);
        assert!(recovered.position.y + recovered.size.height as i32 <= small_area.position.y + small_area.size.height as i32);
        assert!(recovery_bounds(rect(50, 20, 1616, 996), &[area], defaults, minimum, frame).is_none());
    }

    #[test]
    fn restore_preserves_negative_monitor_positions_and_fits_disconnected_display_windows() {
        let areas = [rect(-1920, 0, 1920, 1040), rect(0, 0, 1920, 1040)];
        let defaults = PhysicalSize::new(1600, 980);
        let minimum = PhysicalSize::new(1180, 720);
        let frame = PhysicalSize::new(0, 0);
        assert!(recovery_bounds(rect(-1800, 30, 1400, 900), &areas, defaults, minimum, frame).is_none());
        let repaired = recovery_bounds(rect(4000, 100, 2000, 1200), &areas, defaults, minimum, frame).unwrap();
        assert_eq!(repaired.position, areas[0].position);
        assert_eq!(repaired.size, areas[0].size);
        assert!(recovery_bounds(rect(-32000, -32000, 160, 28), &[], defaults, minimum, frame).is_none());
    }
}
