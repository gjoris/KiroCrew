/**
 * The closed vocabulary a UI location's prerequisites may use, as pure data.
 *
 * One table for the descriptor types (`./descriptors.ts`) and the generator
 * (`scripts/gen-ui-index.mjs`, which copies the descriptions into the index so
 * find_ui can say what each id means). Adding a condition or a reveal state is
 * one entry here; nothing else lists them. No imports: the generator loads this
 * module on its own.
 */

/** Runtime facts a location can need. Each description says what must hold. */
export const UI_CONDITIONS = {
  has_open_sessions: 'at least one open session is listed',
  app_enabled: 'the app that provides this page is installed and enabled',
  full_dashboard: 'the full dashboard is open, not an embedded chat or sessions view',
  no_active_session: 'no session is open in the chat pane',
  no_schedules: 'no scheduled job exists yet',
  has_schedules: 'at least one scheduled job exists',
  search_bar_unclaimed: 'no enabled app has claimed the top-bar search (an app that does turns it into its own launcher)',
  session_open: 'a session is open in the chat pane',
  no_response_running: 'the open session is not answering right now (the control is disabled while a response runs)',
  empty_session: 'the open session has no messages yet',
  not_on_sessions_page: 'the open page is not Sessions (on a phone, Sessions has its own drawer instead)',
  // Declared ahead of the wave-3 area batches, so no batch edits this file
  // (it has one owner). A batch that finds none of these fits stops and asks.
  // Sessions sidebar
  has_closed_sessions: 'at least one closed session is in the history',
  older_sessions_collapsed: 'the Older Sessions list is collapsed',
  sessions_board_view: 'the sessions list is in Board view, with sessions in columns (switch it from the sessions ⋯ menu)',
  sessions_list_view: 'the sessions list is in List view (the default)',
  pointer_on_session_row: 'the pointer or keyboard focus is on a session row of this machine that is not being renamed (the control is drawn on that row)',
  // Shell and notifications
  terminal_enabled: 'the terminal is turned on in Settings',
  developer_mode: 'developer mode is on',
  phone_connect_available: 'pairing a phone is available on this machine',
  kiro_account_entry: 'the menu offers a Kiro account row (always when this installation runs on Kiro; with another backend, only once an account usage reading has arrived)',
  has_notifications: 'at least one notification is listed',
  has_unread_notifications: 'at least one notification is unread',
  notification_selected: 'a notification is open in the detail panel (select it in the list)',
  notification_read: 'the open notification is already read (opening one marks it read; an unread one shows Mark read here instead)',
  // Crewmates
  crewmate_selected: 'a crewmate is selected in the list',
  no_crewmates: 'no crewmate exists yet',
  has_crewmates: 'at least one crewmate exists',
  crewmate_editor_open: "a crewmate's editor is open (choose Edit on that crewmate)",
  // Apps
  has_installed_apps: 'at least one app is installed',
  app_details_open: "an app's detail page is open (in Discover, click the app's card)",
  app_tile_menu_open: "the app card's ⋯ (More actions) menu is open (in Library, point at the app's card to show ⋯, then click it; clicking the card itself opens the app instead)",
  // Schedule, artifacts, skills
  job_open: "a scheduled job's detail panel is open (select the job in the list)",
  job_running: 'the open job is running now',
  job_secret_request_pending: 'the open job is waiting for a secret approval',
  job_details_tab: "the job panel's Details tab is selected (the default; the Logs tab hides this)",
  schedule_list_view: 'the Schedule page shows its List view (the default; the Calendar and Executions views hide this)',
  jobs_checked: 'one or more jobs are checked in the list',
  skill_selected: 'a skill is selected in the list',
  // Composer
  message_typed: 'something is ready to send: text in the message box, an attached file, or a referenced session',
  // Added by the wave-3 integration, one per state a batch found it needed and
  // checked against its render site.
  // Sessions sidebar
  board_missing_state_lanes: 'one of the Board view’s default status columns was removed (this appears only then)',
  // Composer
  response_running: 'the open session is answering right now',
  message_box_empty: 'nothing is waiting to send: no text in the message box and no attached file (with either, this place holds Queue or Steer instead)',
  mouse_input: 'the device is used with a mouse or trackpad, not a touchscreen',
  touch_input: 'the device is used by touch (a tablet or touchscreen), so the message box shows its touch controls',
  screen_capture_available: 'taking a screenshot is supported here (the desktop app, or a Mac)',
  context_usage_reported: 'the open session has reported how full its context is (after its first answer)',
  // Notifications
  new_channel_prompt: 'the first notification from a new channel is asking whether to keep or mute that channel',
  // Crewmates
  crewmate_danger_zone_open: "the crewmate editor shows its Danger zone section (choose Danger zone in the editor's section list; the Captain cannot be deleted)",
  crewmate_panel_not_docked: "the crewmate's details panel is not already docked open beside the chat",
  // Apps (the app whose detail page is open, not the app that provides the page)
  open_app_not_installed: 'the open app is not installed yet and can be installed from the dashboard',
  open_app_enabled: 'the open app is a regular installed app (not a built-in or independently managed one) and is turned on',
  open_app_syncable: 'the open app is a regular installed app with no newer version waiting; Sync reloads its installed files and does not install a new release',
  open_app_update_available: 'the open app is a regular installed app and a newer version is waiting (Update stands where Sync otherwise is)',
  open_app_removable: 'the open app is a regular installed app (not a built-in or independently managed one) that is not locked against removal',
  // Schedule
  job_not_running: 'the open job is not running now (while it runs, Cancel Run stands in this place)',
  // Shell
  nav_rail_expanded: 'the navigation rail is expanded, showing labels',
  // Artifacts
  cloud_deploy_available: "this installation can publish to a public cloud URL (the built-in AWS destination is offered)",
  // Added with the demand-gap batch (each checked against its render site).
  // Composer
  voice_input_supported: 'this browser can record from a microphone (the mic button is not drawn otherwise)',
  // Schedule
  job_enabled: 'the open job is active (not paused)',
  job_paused: 'the open job is paused',
  // Crewmates
  crewmate_place_pane_open: "the crewmate editor shows its Workspace · Memory section (choose it in the editor's section list)",
  crewmate_memory_manageable: 'the crewmate keeps a private memory of its own, or is the Captain, whose memory is the shared global one (with any other binding there is nothing to manage here)',
  // Artifacts
  artifact_open: "an artifact's own page is open (click the artifact in the library)",
  // Shell: the docked terminal panel (BottomTerminalPanel)
  terminal_not_popped_out: 'the terminal is docked in the dashboard, not popped out to its own window',
  terminal_docked_bottom: 'the terminal panel sits below the chat (the default)',
  terminal_docked_right: 'the terminal panel sits to the right of the chat, side by side with it',
} as const

export type UiConditionId = keyof typeof UI_CONDITIONS

/**
 * States a reveal step is conditional on: `shown_by` with `when` means "do this
 * first only while <state>; otherwise the target is already visible".
 */
export const UI_REVEAL_STATES = {
  sessions_sidebar_collapsed: 'the sessions sidebar is collapsed',
  sessions_drawer_closed: 'the sessions drawer is closed',
  nav_rail_collapsed: 'the navigation rail is collapsed to icons',
  composer_collapsed: 'the message box is collapsed to a single bar (the choice is remembered after a reload)',
  side_panel_closed: "the chat's side panel is closed",
  terminal_panel_closed: 'the terminal panel is closed (the Terminal row in the navigation rail opens it)',
  crewmate_roster_folded: 'a crewmate chat is open on a wide screen, which folds the roster column away',
  crewmate_chat_open_phone: 'a crewmate chat fills the phone screen, so the roster is behind it',
} as const

export type UiRevealState = keyof typeof UI_REVEAL_STATES
