// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported componentManager, notificationDaemon, windowAttentionHandler, padOsdService, 
            osdWindowManager, osdMonitorLabeler, shellMountOpDBusService, shellDBusService,
            shellAccessDialogDBusService, shellAudioSelectionDBusService,
            screenSaverDBus, uiGroup, magnifier, xdndHandler, keyboard,
            kbdA11yDialog, introspectService, start, pushModal, popModal,
            activateWindow, moveWindowToMonitorAndWorkspace,
            createLookingGlass, initializeDeferredWork,
            getStyleVariant, getThemeStylesheet, setThemeStylesheet, screenshotUI */

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const AccessDialog = imports.ui.accessDialog;
const AudioDeviceSelection = imports.ui.audioDeviceSelection;
const Components = imports.ui.components;
const EndSessionDialog = imports.ui.endSessionDialog;
const ExtensionSystem = imports.ui.extensionSystem;
const ExtensionDownloader = imports.ui.extensionDownloader;
const InputMethod = imports.misc.inputMethod;
const Introspect = imports.misc.introspect;
const Keyboard = imports.ui.keyboard;
const MessageTray = imports.ui.messageTray;
const ModalDialog = imports.ui.modalDialog;
const OsdWindow = imports.ui.osdWindow;
const OsdMonitorLabeler = imports.ui.osdMonitorLabeler;
const Overview = imports.ui.overview;
const PadOsd = imports.ui.padOsd;
const Panel = imports.ui.panel;
const Params = imports.misc.params;
const RunDialog = imports.ui.runDialog;
const WelcomeDialog = imports.ui.welcomeDialog;
const Layout = imports.ui.layout;
const LoginManager = imports.misc.loginManager;
const LookingGlass = imports.ui.lookingGlass;
const NotificationDaemon = imports.ui.notificationDaemon;
const WindowAttentionHandler = imports.ui.windowAttentionHandler;
const Screenshot = imports.ui.screenshot;
const ScreenShield = imports.ui.screenShield;
const Scripting = imports.ui.scripting;
const SessionMode = imports.ui.sessionMode;
const ShellDBus = imports.ui.shellDBus;
const ShellMountOperation = imports.ui.shellMountOperation;
const WindowManager = imports.ui.windowManager;
const Magnifier = imports.ui.magnifier;
const XdndHandler = imports.ui.xdndHandler;
const KbdA11yDialog = imports.ui.kbdA11yDialog;
const LocatePointer = imports.ui.locatePointer;
const PointerA11yTimeout = imports.ui.pointerA11yTimeout;
const ParentalControlsManager = imports.misc.parentalControlsManager;
const Config = imports.misc.config;
const Util = imports.misc.util;

const WELCOME_DIALOG_LAST_SHOWN_VERSION = 'welcome-dialog-last-shown-version';
// Make sure to mention the point release, otherwise it will show every time
// until this version is current
const WELCOME_DIALOG_LAST_TOUR_CHANGE = '40.beta';
const LOG_DOMAIN = 'GNOME Shell';
const GNOMESHELL_STARTED_MESSAGE_ID = 'f3ea493c22934e26811cd62abe8e203a';

var componentManager = null;
var extensionManager = null;
var panel = null;
var overview = null;
var runDialog = null;
var lookingGlass = null;
var welcomeDialog = null;
var wm = null;
var messageTray = null;
var screenShield = null;
var notificationDaemon = null;
var windowAttentionHandler = null;
var padOsdService = null;
var osdWindowManager = null;
var osdMonitorLabeler = null;
var sessionMode = null;
var screenshotUI = null;
var shellAccessDialogDBusService = null;
var shellAudioSelectionDBusService = null;
var shellDBusService = null;
var shellMountOpDBusService = null;
var screenSaverDBus = null;
var modalCount = 0;
var actionMode = Shell.ActionMode.NONE;
var modalActorFocusStack = [];
var uiGroup = null;
var magnifier = null;
var xdndHandler = null;
var keyboard = null;
var layoutManager = null;
var kbdA11yDialog = null;
var inputMethod = null;
var introspectService = null;
var locatePointer = null;
let _startDate;
let _defaultCssStylesheet = null;
let _cssStylesheet = null;
let _themeResource = null;
let _oskResource = null;
let _iconResource = null;

Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'touch_async');

let _remoteAccessInhibited = false;

function _sessionUpdated() {
    if (sessionMode.isPrimary)
        _loadDefaultStylesheet();

    wm.allowKeybinding('overlay-key', Shell.ActionMode.NORMAL |
                                      Shell.ActionMode.OVERVIEW);

    wm.allowKeybinding('locate-pointer-key', Shell.ActionMode.ALL);

    wm.setCustomKeybindingHandler('panel-run-dialog',
                                  Shell.ActionMode.NORMAL |
                                  Shell.ActionMode.OVERVIEW,
                                  sessionMode.hasRunDialog ? openRunDialog : null);

    if (!sessionMode.hasRunDialog) {
        if (runDialog)
            runDialog.close();
        if (lookingGlass)
            lookingGlass.close();
        if (welcomeDialog)
            welcomeDialog.close();
    }

    let remoteAccessController = global.backend.get_remote_access_controller();
    if (remoteAccessController && !global.backend.is_headless()) {
        if (sessionMode.allowScreencast && _remoteAccessInhibited) {
            remoteAccessController.uninhibit_remote_access();
            _remoteAccessInhibited = false;
        } else if (!sessionMode.allowScreencast && !_remoteAccessInhibited) {
            remoteAccessController.inhibit_remote_access();
            _remoteAccessInhibited = true;
        }
    }
}

/**
 * @param {any...} args a list of values to log
 */
function _loggingFunc(...args) {
    let fields = { 'MESSAGE': args.join(', ') };
    let domain = 'GNOME Shell';

    // If the caller is an extension, add it as metadata
    let extension = imports.misc.extensionUtils.getCurrentExtension();
    if (extension != null) {
        domain = extension.metadata.name;
        fields['GNOME_SHELL_EXTENSION_UUID'] = extension.uuid;
        fields['GNOME_SHELL_EXTENSION_NAME'] = extension.metadata.name;
    }

    GLib.log_structured(domain, GLib.LogLevelFlags.LEVEL_MESSAGE, fields);
}

function start() {
    globalThis.log = _loggingFunc;

    // These are here so we don't break compatibility.
    global.logError = globalThis.log;
    global.log = globalThis.log;

    // Chain up async errors reported from C
    global.connect('notify-error', (global, msg, detail) => {
        notifyError(msg, detail);
    });

    let currentDesktop = GLib.getenv('XDG_CURRENT_DESKTOP');
    if (!currentDesktop || !currentDesktop.split(':').includes('GNOME'))
        Gio.DesktopAppInfo.set_desktop_env('GNOME');

    sessionMode = new SessionMode.SessionMode();
    sessionMode.connect('updated', _sessionUpdated);

    St.Settings.get().connect('notify::high-contrast', _loadDefaultStylesheet);
    St.Settings.get().connect('notify::color-scheme', _loadDefaultStylesheet);

    // Initialize ParentalControlsManager before the UI
    ParentalControlsManager.getDefault();

    _initializeUI();

    shellAccessDialogDBusService = new AccessDialog.AccessDialogDBus();
    shellAudioSelectionDBusService = new AudioDeviceSelection.AudioDeviceSelectionDBus();
    shellDBusService = new ShellDBus.GnomeShell();
    shellMountOpDBusService = new ShellMountOperation.GnomeShellMountOpHandler();

    const watchId = Gio.DBus.session.watch_name('org.gnome.Shell.Notifications',
        Gio.BusNameWatcherFlags.AUTO_START,
        bus => bus.unwatch_name(watchId),
        bus => bus.unwatch_name(watchId));

    _sessionUpdated();
}

function _initializeUI() {
    // Ensure ShellWindowTracker and ShellAppUsage are initialized; this will
    // also initialize ShellAppSystem first. ShellAppSystem
    // needs to load all the .desktop files, and ShellWindowTracker
    // will use those to associate with windows. Right now
    // the Monitor doesn't listen for installed app changes
    // and recalculate application associations, so to avoid
    // races for now we initialize it here. It's better to
    // be predictable anyways.
    Shell.WindowTracker.get_default();
    Shell.AppUsage.get_default();

    reloadThemeResource();
    _loadIcons();
    _loadOskLayouts();
    _loadDefaultStylesheet();

    new AnimationsSettings();

    // Setup the stage hierarchy early
    layoutManager = new Layout.LayoutManager();

    // Various parts of the codebase still refer to Main.uiGroup
    // instead of using the layoutManager. This keeps that code
    // working until it's updated.
    uiGroup = layoutManager.uiGroup;

    padOsdService = new PadOsd.PadOsdService();
    xdndHandler = new XdndHandler.XdndHandler();
    osdWindowManager = new OsdWindow.OsdWindowManager();
    osdMonitorLabeler = new OsdMonitorLabeler.OsdMonitorLabeler();
    overview = new Overview.Overview();
    kbdA11yDialog = new KbdA11yDialog.KbdA11yDialog();
    wm = new WindowManager.WindowManager();
    magnifier = new Magnifier.Magnifier();
    locatePointer = new LocatePointer.LocatePointer();

    if (LoginManager.canLock())
        screenShield = new ScreenShield.ScreenShield();

    inputMethod = new InputMethod.InputMethod();
    Clutter.get_default_backend().set_input_method(inputMethod);
    global.connect('shutdown',
        () => Clutter.get_default_backend().set_input_method(null));

    screenshotUI = new Screenshot.ScreenshotUI();

    messageTray = new MessageTray.MessageTray();
    panel = new Panel.Panel();
    keyboard = new Keyboard.KeyboardManager();
    notificationDaemon = new NotificationDaemon.NotificationDaemon();
    windowAttentionHandler = new WindowAttentionHandler.WindowAttentionHandler();
    componentManager = new Components.ComponentManager();

    introspectService = new Introspect.IntrospectService();

    layoutManager.init();
    overview.init();

    new PointerA11yTimeout.PointerA11yTimeout();

    global.connect('locate-pointer', () => {
        locatePointer.show();
    });

    global.display.connect('show-restart-message', (display, message) => {
        showRestartMessage(message);
        return true;
    });

    global.display.connect('restart', () => {
        global.reexec_self();
        return true;
    });

    global.display.connect('gl-video-memory-purged', loadTheme);

    global.context.connect('notify::unsafe-mode', () => {
        if (!global.context.unsafe_mode)
            return; // we're safe
        if (lookingGlass?.isOpen)
            return; // assume user action

        const source = new MessageTray.SystemNotificationSource();
        messageTray.add(source);
        const notification = new MessageTray.Notification(source,
            _('System was put in unsafe mode'),
            _('Apps now have unrestricted access'));
        notification.addAction(_('Undo'),
            () => (global.context.unsafe_mode = false));
        notification.setTransient(true);
        source.showNotification(notification);
    });

    // Provide the bus object for gnome-session to
    // initiate logouts.
    EndSessionDialog.init();

    // We're ready for the session manager to move to the next phase
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        Shell.util_sd_notify();
        global.context.notify_ready();
        return GLib.SOURCE_REMOVE;
    });

    _startDate = new Date();

    ExtensionDownloader.init();
    extensionManager = new ExtensionSystem.ExtensionManager();
    extensionManager.init();

    if (sessionMode.isGreeter && screenShield) {
        layoutManager.connect('startup-prepared', () => {
            screenShield.showDialog();
        });
    }

    let perfModule;
    const perfModuleName = GLib.getenv('SHELL_PERF_MODULE');
    if (perfModuleName) {
        perfModule = eval(`imports.perf.${perfModuleName};`);
        if (perfModule.init)
            perfModule.init();
    }

    layoutManager.connect('startup-complete', () => {
        if (actionMode == Shell.ActionMode.NONE)
            actionMode = Shell.ActionMode.NORMAL;

        if (screenShield)
            screenShield.lockIfWasLocked();

        if (sessionMode.currentMode != 'gdm' &&
            sessionMode.currentMode != 'initial-setup') {
            GLib.log_structured(LOG_DOMAIN, GLib.LogLevelFlags.LEVEL_MESSAGE, {
                'MESSAGE': `GNOME Shell started at ${_startDate}`,
                'MESSAGE_ID': GNOMESHELL_STARTED_MESSAGE_ID,
            });
        }

        if (!perfModule) {
            let credentials = new Gio.Credentials();
            if (credentials.get_unix_user() === 0) {
                notify(
                    _('Logged in as a privileged user'),
                    _('Running a session as a privileged user should be avoided for security reasons. If possible, you should log in as a normal user.'));
            } else if (sessionMode.showWelcomeDialog) {
                _handleShowWelcomeScreen();
            }
        }

        if (sessionMode.currentMode !== 'gdm' &&
            sessionMode.currentMode !== 'initial-setup')
            _handleLockScreenWarning();

        LoginManager.registerSessionWithGDM();

        if (perfModule) {
            let perfOutput = GLib.getenv("SHELL_PERF_OUTPUT");
            Scripting.runPerfScript(perfModule, perfOutput);
        }
    });
}

function _handleShowWelcomeScreen() {
    const lastShownVersion = global.settings.get_string(WELCOME_DIALOG_LAST_SHOWN_VERSION);
    if (Util.GNOMEversionCompare(WELCOME_DIALOG_LAST_TOUR_CHANGE, lastShownVersion) > 0) {
        openWelcomeDialog();
        global.settings.set_string(WELCOME_DIALOG_LAST_SHOWN_VERSION, Config.PACKAGE_VERSION);
    }
}

async function _handleLockScreenWarning() {
    const path = `${global.userdatadir}/lock-warning-shown`;
    const file = Gio.File.new_for_path(path);

    const hasLockScreen = screenShield !== null;
    if (hasLockScreen) {
        try {
            await file.delete_async(0, null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                logError(e);
        }
    } else {
        try {
            if (!await file.touch_async())
                return;
        } catch (e) {
            logError(e);
        }

        notify(
            _('Screen Lock disabled'),
            _('Screen Locking requires the GNOME display manager.'));
    }
}

function _getStylesheet(name) {
    let stylesheet;

    stylesheet = Gio.File.new_for_uri(`resource:///org/gnome/shell/theme/${name}`);
    if (stylesheet.query_exists(null))
        return stylesheet;

    let dataDirs = GLib.get_system_data_dirs();
    for (let i = 0; i < dataDirs.length; i++) {
        let path = GLib.build_filenamev([dataDirs[i], 'gnome-shell', 'theme', name]);
        stylesheet = Gio.file_new_for_path(path);
        if (stylesheet.query_exists(null))
            return stylesheet;
    }

    stylesheet = Gio.File.new_for_path(`${global.datadir}/theme/${name}`);
    if (stylesheet.query_exists(null))
        return stylesheet;

    return null;
}

/** @returns {string} */
function getStyleVariant() {
    const {colorScheme} = St.Settings.get();
    switch (sessionMode.colorScheme) {
    case 'force-dark':
        return 'dark';
    case 'force-light':
        return 'light';
    case 'prefer-dark':
        return colorScheme === St.SystemColorScheme.PREFER_LIGHT
            ? 'light' : 'dark';
    case 'prefer-light':
        return colorScheme === St.SystemColorScheme.PREFER_DARK
            ? 'dark' : 'light';
    default:
        return '';
    }
}

function _getDefaultStylesheet() {
    let stylesheet = null;
    let name = sessionMode.stylesheetName;

    // Look for a high-contrast variant first
    if (St.Settings.get().high_contrast)
        stylesheet = _getStylesheet(name.replace('.css', '-high-contrast.css'));

    if (stylesheet === null)
        stylesheet = _getStylesheet(name.replace('.css', `-${getStyleVariant()}.css`));

    if (stylesheet == null)
        stylesheet = _getStylesheet(name);

    return stylesheet;
}

function _loadDefaultStylesheet() {
    let stylesheet = _getDefaultStylesheet();
    if (_defaultCssStylesheet && _defaultCssStylesheet.equal(stylesheet))
        return;

    _defaultCssStylesheet = stylesheet;
    loadTheme();
}

/**
 * getThemeStylesheet:
 *
 * Get the theme CSS file that the shell will load
 *
 * @returns {?Gio.File}: A #GFile that contains the theme CSS,
 *          null if using the default
 */
function getThemeStylesheet() {
    return _cssStylesheet;
}

/**
 * setThemeStylesheet:
 * @param {string=} cssStylesheet: A file path that contains the theme CSS,
 *     set it to null to use the default
 *
 * Set the theme CSS file that the shell will load
 */
function setThemeStylesheet(cssStylesheet) {
    _cssStylesheet = cssStylesheet ? Gio.File.new_for_path(cssStylesheet) : null;
}

function reloadThemeResource() {
    if (_themeResource)
        _themeResource._unregister();

    _themeResource = Gio.Resource.load(
        `${global.datadir}/${sessionMode.themeResourceName}`);
    _themeResource._register();
}

/** @private */
function _loadIcons() {
    _iconResource = Gio.Resource.load(`${global.datadir}/gnome-shell-icons.gresource`);
    _iconResource._register();
}

function _loadOskLayouts() {
    _oskResource = Gio.Resource.load(`${global.datadir}/gnome-shell-osk-layouts.gresource`);
    _oskResource._register();
}

/**
 * loadTheme:
 *
 * Reloads the theme CSS file
 */
function loadTheme() {
    let themeContext = St.ThemeContext.get_for_stage(global.stage);
    let previousTheme = themeContext.get_theme();

    let theme = new St.Theme({
        application_stylesheet: _cssStylesheet,
        default_stylesheet: _defaultCssStylesheet,
    });

    if (theme.default_stylesheet == null)
        throw new Error(`No valid stylesheet found for '${sessionMode.stylesheetName}'`);

    if (previousTheme) {
        let customStylesheets = previousTheme.get_custom_stylesheets();

        for (let i = 0; i < customStylesheets.length; i++)
            theme.load_stylesheet(customStylesheets[i]);
    }

    themeContext.set_theme(theme);
}

/**
 * notify:
 * @param {string} msg: A message
 * @param {string} details: Additional information
 */
function notify(msg, details) {
    let source = new MessageTray.SystemNotificationSource();
    messageTray.add(source);
    let notification = new MessageTray.Notification(source, msg, details);
    notification.setTransient(true);
    source.showNotification(notification);
}

/**
 * notifyError:
 * @param {string} msg: An error message
 * @param {string} details: Additional information
 *
 * See shell_global_notify_problem().
 */
function notifyError(msg, details) {
    // Also print to stderr so it's logged somewhere
    if (details)
        console.warn(`error: ${msg}: ${details}`);
    else
        console.warn(`error: ${msg}`);

    notify(msg, details);
}

/**
 * _findModal:
 *
 * @param {Clutter.Grab} grab - grab
 *
 * Private function.
 *
 */
function _findModal(grab) {
    for (let i = 0; i < modalActorFocusStack.length; i++) {
        if (modalActorFocusStack[i].grab === grab)
            return i;
    }
    return -1;
}

/**
 * pushModal:
 * @param {Clutter.Actor} actor: actor which will be given keyboard focus
 * @param {Object=} params: optional parameters
 *
 * Ensure we are in a mode where all keyboard and mouse input goes to
 * the stage, and focus @actor. Multiple calls to this function act in
 * a stacking fashion; the effect will be undone when an equal number
 * of popModal() invocations have been made.
 *
 * Next, record the current Clutter keyboard focus on a stack. If the
 * modal stack returns to this actor, reset the focus to the actor
 * which was focused at the time pushModal() was invoked.
 *
 * @params may be used to provide the following parameters:
 *  - timestamp: used to associate the call with a specific user initiated
 *               event. If not provided then the value of
 *               global.get_current_time() is assumed.
 *
 *  - options: Meta.ModalOptions flags to indicate that the pointer is
 *             already grabbed
 *
 *  - actionMode: used to set the current Shell.ActionMode to filter
 *                global keybindings; the default of NONE will filter
 *                out all keybindings
 *
 * @returns {Clutter.Grab}: the grab handle created
 */
function pushModal(actor, params) {
    params = Params.parse(params, {
        timestamp: global.get_current_time(),
        options: 0,
        actionMode: Shell.ActionMode.NONE,
    });

    let grab = global.stage.grab(actor);

    if (modalCount === 0)
        Meta.disable_unredirect_for_display(global.display);

    modalCount += 1;
    let actorDestroyId = actor.connect('destroy', () => {
        let index = _findModal(grab);
        if (index >= 0)
            popModal(grab);
    });

    let prevFocus = global.stage.get_key_focus();
    let prevFocusDestroyId;
    if (prevFocus != null) {
        prevFocusDestroyId = prevFocus.connect('destroy', () => {
            const index = modalActorFocusStack.findIndex(
                record => record.prevFocus === prevFocus);

            if (index >= 0)
                modalActorFocusStack[index].prevFocus = null;
        });
    }
    modalActorFocusStack.push({
        actor,
        grab,
        destroyId: actorDestroyId,
        prevFocus,
        prevFocusDestroyId,
        actionMode,
    });

    actionMode = params.actionMode;
    global.stage.set_key_focus(actor);
    return grab;
}

/**
 * popModal:
 * @param {Clutter.Grab} grab - the grab given by pushModal()
 * @param {number=} timestamp - optional timestamp
 *
 * Reverse the effect of pushModal(). If this invocation is undoing
 * the topmost invocation, then the focus will be restored to the
 * previous focus at the time when pushModal() was invoked.
 *
 * @timestamp is optionally used to associate the call with a specific user
 * initiated event. If not provided then the value of
 * global.get_current_time() is assumed.
 */
function popModal(grab, timestamp) {
    if (timestamp == undefined)
        timestamp = global.get_current_time();

    let focusIndex = _findModal(grab);
    if (focusIndex < 0) {
        global.stage.set_key_focus(null);
        actionMode = Shell.ActionMode.NORMAL;

        throw new Error('incorrect pop');
    }

    modalCount -= 1;

    let record = modalActorFocusStack[focusIndex];
    record.actor.disconnect(record.destroyId);

    record.grab.dismiss();

    if (focusIndex == modalActorFocusStack.length - 1) {
        if (record.prevFocus)
            record.prevFocus.disconnect(record.prevFocusDestroyId);
        actionMode = record.actionMode;
        global.stage.set_key_focus(record.prevFocus);
    } else {
        // If we have:
        //     global.stage.set_focus(a);
        //     Main.pushModal(b);
        //     Main.pushModal(c);
        //     Main.pushModal(d);
        //
        // then we have the stack:
        //     [{ prevFocus: a, actor: b },
        //      { prevFocus: b, actor: c },
        //      { prevFocus: c, actor: d }]
        //
        // When actor c is destroyed/popped, if we only simply remove the
        // record, then the focus stack will be [a, c], rather than the correct
        // [a, b]. Shift the focus stack up before removing the record to ensure
        // that we get the correct result.
        let t = modalActorFocusStack[modalActorFocusStack.length - 1];
        if (t.prevFocus)
            t.prevFocus.disconnect(t.prevFocusDestroyId);
        // Remove from the middle, shift the focus chain up
        for (let i = modalActorFocusStack.length - 1; i > focusIndex; i--) {
            modalActorFocusStack[i].prevFocus = modalActorFocusStack[i - 1].prevFocus;
            modalActorFocusStack[i].prevFocusDestroyId = modalActorFocusStack[i - 1].prevFocusDestroyId;
            modalActorFocusStack[i].actionMode = modalActorFocusStack[i - 1].actionMode;
        }
    }
    modalActorFocusStack.splice(focusIndex, 1);

    if (modalCount > 0)
        return;

    layoutManager.modalEnded();
    Meta.enable_unredirect_for_display(global.display);
    actionMode = Shell.ActionMode.NORMAL;
}

function createLookingGlass() {
    if (lookingGlass == null)
        lookingGlass = new LookingGlass.LookingGlass();

    return lookingGlass;
}

function openRunDialog() {
    if (runDialog == null)
        runDialog = new RunDialog.RunDialog();

    runDialog.open();
}

function openWelcomeDialog() {
    if (welcomeDialog === null)
        welcomeDialog = new WelcomeDialog.WelcomeDialog();

    welcomeDialog.open();
}

/**
 * activateWindow:
 * @param {Meta.Window} window: the window to activate
 * @param {number=} time: current event time
 * @param {number=} workspaceNum:  window's workspace number
 *
 * Activates @window, switching to its workspace first if necessary,
 * and switching out of the overview if it's currently active
 */
function activateWindow(window, time, workspaceNum) {
    let workspaceManager = global.workspace_manager;
    let activeWorkspaceNum = workspaceManager.get_active_workspace_index();
    let windowWorkspaceNum = workspaceNum !== undefined ? workspaceNum : window.get_workspace().index();

    if (!time)
        time = global.get_current_time();

    if (windowWorkspaceNum != activeWorkspaceNum) {
        let workspace = workspaceManager.get_workspace_by_index(windowWorkspaceNum);
        workspace.activate_with_focus(window, time);
    } else {
        window.activate(time);
    }

    overview.hide();
    panel.closeCalendar();
}

/**
 * Move @window to the specified monitor and workspace.
 *
 * @param {Meta.Window} window - the window to move
 * @param {number} monitorIndex - the requested monitor
 * @param {number} workspaceIndex - the requested workspace
 * @param {bool} append - create workspace if it doesn't exist
 */
function moveWindowToMonitorAndWorkspace(window, monitorIndex, workspaceIndex, append = false) {
    // We need to move the window before changing the workspace, because
    // the move itself could cause a workspace change if the window enters
    // the primary monitor
    if (window.get_monitor() !== monitorIndex) {
        // Wait for the monitor change to take effect
        const id = global.display.connect('window-entered-monitor',
            (dsp, num, w) => {
                if (w !== window)
                    return;
                window.change_workspace_by_index(workspaceIndex, append);
                global.display.disconnect(id);
            });
        window.move_to_monitor(monitorIndex);
    } else {
        window.change_workspace_by_index(workspaceIndex, append);
    }
}

// TODO - replace this timeout with some system to guess when the user might
// be e.g. just reading the screen and not likely to interact.
var DEFERRED_TIMEOUT_SECONDS = 20;
var _deferredWorkData = {};
// Work scheduled for some point in the future
var _deferredWorkQueue = [];
// Work we need to process before the next redraw
var _beforeRedrawQueue = [];
// Counter to assign work ids
var _deferredWorkSequence = 0;
var _deferredTimeoutId = 0;

function _runDeferredWork(workId) {
    if (!_deferredWorkData[workId])
        return;
    let index = _deferredWorkQueue.indexOf(workId);
    if (index < 0)
        return;

    _deferredWorkQueue.splice(index, 1);
    _deferredWorkData[workId].callback();
    if (_deferredWorkQueue.length == 0 && _deferredTimeoutId > 0) {
        GLib.source_remove(_deferredTimeoutId);
        _deferredTimeoutId = 0;
    }
}

function _runAllDeferredWork() {
    while (_deferredWorkQueue.length > 0)
        _runDeferredWork(_deferredWorkQueue[0]);
}

function _runBeforeRedrawQueue() {
    for (let i = 0; i < _beforeRedrawQueue.length; i++) {
        let workId = _beforeRedrawQueue[i];
        _runDeferredWork(workId);
    }
    _beforeRedrawQueue = [];
}

function _queueBeforeRedraw(workId) {
    _beforeRedrawQueue.push(workId);
    if (_beforeRedrawQueue.length == 1) {
        const laters = global.compositor.get_laters();
        laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            _runBeforeRedrawQueue();
            return false;
        });
    }
}

/**
 * initializeDeferredWork:
 * @param {Clutter.Actor} actor: an actor
 * @param {callback} callback: Function to invoke to perform work
 *
 * This function sets up a callback to be invoked when either the
 * given actor is mapped, or after some period of time when the machine
 * is idle. This is useful if your actor isn't always visible on the
 * screen (for example, all actors in the overview), and you don't want
 * to consume resources updating if the actor isn't actually going to be
 * displaying to the user.
 *
 * Note that queueDeferredWork is called by default immediately on
 * initialization as well, under the assumption that new actors
 * will need it.
 *
 * @returns {string}: A string work identifier
 */
function initializeDeferredWork(actor, callback) {
    // Turn into a string so we can use as an object property
    let workId = `${++_deferredWorkSequence}`;
    _deferredWorkData[workId] = {
        actor,
        callback,
    };
    actor.connect('notify::mapped', () => {
        if (!(actor.mapped && _deferredWorkQueue.includes(workId)))
            return;
        _queueBeforeRedraw(workId);
    });
    actor.connect('destroy', () => {
        let index = _deferredWorkQueue.indexOf(workId);
        if (index >= 0)
            _deferredWorkQueue.splice(index, 1);
        delete _deferredWorkData[workId];
    });
    queueDeferredWork(workId);
    return workId;
}

/**
 * queueDeferredWork:
 * @param {string} workId: work identifier
 *
 * Ensure that the work identified by @workId will be
 * run on map or timeout. You should call this function
 * for example when data being displayed by the actor has
 * changed.
 */
function queueDeferredWork(workId) {
    let data = _deferredWorkData[workId];
    if (!data) {
        let message = `Invalid work id ${workId}`;
        logError(new Error(message), message);
        return;
    }
    if (!_deferredWorkQueue.includes(workId))
        _deferredWorkQueue.push(workId);
    if (data.actor.mapped) {
        _queueBeforeRedraw(workId);
    } else if (_deferredTimeoutId == 0) {
        _deferredTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, DEFERRED_TIMEOUT_SECONDS, () => {
            _runAllDeferredWork();
            _deferredTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(_deferredTimeoutId, '[gnome-shell] _runAllDeferredWork');
    }
}

var RestartMessage = GObject.registerClass(
class RestartMessage extends ModalDialog.ModalDialog {
    _init(message) {
        super._init({
            shellReactive: true,
            styleClass: 'restart-message headline',
            shouldFadeIn: false,
            destroyOnClose: true,
        });

        let label = new St.Label({
            text: message,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.contentLayout.add_child(label);
        this.buttonLayout.hide();
    }
});

function showRestartMessage(message) {
    let restartMessage = new RestartMessage(message);
    restartMessage.open();
}

var AnimationsSettings = class {
    constructor() {
        this._animationsEnabled = true;
        this._handles = new Set();

        global.connect('notify::force-animations',
            this._syncAnimationsEnabled.bind(this));
        this._syncAnimationsEnabled();

        const backend = global.backend;
        const remoteAccessController = backend.get_remote_access_controller();
        if (remoteAccessController) {
            remoteAccessController.connect('new-handle',
                (_, handle) => this._onNewRemoteAccessHandle(handle));
        }
    }

    _shouldEnableAnimations() {
        if (this._handles.size > 0)
            return false;

        if (global.force_animations)
            return true;

        const backend = global.backend;
        if (!backend.is_rendering_hardware_accelerated())
            return false;

        if (Shell.util_has_x11_display_extension(
            global.display, 'VNC-EXTENSION'))
            return false;

        return true;
    }

    _syncAnimationsEnabled() {
        const shouldEnableAnimations = this._shouldEnableAnimations();
        if (this._animationsEnabled === shouldEnableAnimations)
            return;
        this._animationsEnabled = shouldEnableAnimations;

        const settings = St.Settings.get();
        if (shouldEnableAnimations)
            settings.uninhibit_animations();
        else
            settings.inhibit_animations();
    }

    _onRemoteAccessHandleStopped(handle) {
        this._handles.delete(handle);
        this._syncAnimationsEnabled();
    }

    _onNewRemoteAccessHandle(handle) {
        if (!handle.get_disable_animations())
            return;

        this._handles.add(handle);
        this._syncAnimationsEnabled();
        handle.connect('stopped', this._onRemoteAccessHandleStopped.bind(this));
    }
};
