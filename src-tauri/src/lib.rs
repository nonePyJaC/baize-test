mod agent;
mod ai_tools;
mod api_debug;
mod case_revision;
mod docx_assets;
mod integrations;
mod llm;

use tauri::Manager;
mod sessions;
mod workspace;
mod yunxiao;

use ai_tools::journal::{apply_ai_session_restore, list_ai_session_runs, plan_ai_session_restore};
use ai_tools::{
    read_ai_session_file, read_ai_session_xmind, run_ai_session_tool, run_approved_ai_session_tool,
    write_ai_session_xmind, write_ai_session_xmind_approved, write_ai_session_xmind_with_records,
};
use sessions::{
    append_ai_session_message, create_ai_session, delete_ai_session, list_ai_sessions,
    read_ai_session, read_ai_session_attachment, save_ai_session_image, set_ai_session_archived,
    update_ai_session, update_ai_session_memory,
};

use docx_assets::{prepare_docx_assets, write_docx_asset_file};
use llm::{
    cancel_ai_session_run, chat_completion, chat_completion_stream, chat_completion_with_tools,
    verify_model_provider,
};
use sessions::{decide_ai_approval, request_ai_approval};
use workspace::*;
use yunxiao::{
    create_yunxiao_bug, create_yunxiao_test_plan, create_yunxiao_test_task, get_yunxiao_testcase,
    get_yunxiao_workitem, list_yunxiao_org_members, list_yunxiao_projects, list_yunxiao_sprints,
    list_yunxiao_sub_workitems, list_yunxiao_test_plans, list_yunxiao_test_repos,
    list_yunxiao_testcase_directories, list_yunxiao_workitem_type_fields,
    list_yunxiao_workitem_types, search_yunxiao_testcases, search_yunxiao_workitems,
    update_yunxiao_workitem, upload_yunxiao_workitem_attachment, verify_yunxiao_token,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(api_debug::ApiDebugState::default())
        .manage(WorkspaceWatcherState::default())
        .setup(|app| {
            app.manage(agent::AgentState::new(app.handle().clone()));
            Ok(())
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            api_debug::load_api_debug_library,
            api_debug::save_api_debug_library,
            api_debug::discover_api_debug_sources,
            api_debug::execute_api_debug_request,
            api_debug::cancel_api_debug_request,
            integrations::integration_call,
            integrations::publication::preview_publication,
            integrations::publication::execute_publication,
            integrations::publication::publication_history,
            integrations::publication::list_publication_history,
            integrations::publication::reconcile_publication,
            integrations::migration::preview_integration_migration,
            integrations::migration::apply_integration_migration,
            integrations::migration::restore_integration_migration,
            case_revision::commit_case_revision,
            case_revision::confirm_case_finalization,
            case_revision::read_case_revision_files,
            save_json_file_if_unchanged,
            open_workspace,
            init_workspace,
            start_workspace_watcher,
            stop_workspace_watcher,
            scan_platforms_cmd,
            create_platform,
            update_platform,
            save_workspace_config,
            delete_platform,
            create_requirement,
            create_ai_task,
            run_ai_task,
            write_ai_task_outputs,
            list_ai_tasks,
            accept_ai_task_result,
            reject_ai_task_result,
            accept_and_unlock_ai_task,
            redispatch_ai_task,
            scan_requirements,
            scan_test_assets,
            read_requirement,
            save_requirement,
            lock_requirement,
            scan_requirement_changes,
            accept_unlock_requirement,
            force_unlock_requirement,
            transition_requirement_stage,
            append_requirement_activity,
            read_requirement_activity,
            create_directory,
            write_binary_file,
            create_binary_file,
            read_binary_file,
            read_text_file,
            write_text_file,
            list_directory,
            get_path_info,
            save_json_file,
            create_json_file,
            read_json_file,
            create_text_file,
            rename_path,
            delete_path,
            import_files,
            append_workspace_log,
            list_workspace_logs,
            search_workspace,
            verify_yunxiao_token,
            list_yunxiao_projects,
            list_yunxiao_sprints,
            search_yunxiao_workitems,
            get_yunxiao_workitem,
            list_yunxiao_sub_workitems,
            create_yunxiao_test_task,
            create_yunxiao_test_plan,
            create_yunxiao_bug,
            upload_yunxiao_workitem_attachment,
            update_yunxiao_workitem,
            prepare_docx_assets,
            write_docx_asset_file,
            list_yunxiao_workitem_type_fields,
            list_yunxiao_workitem_types,
            list_yunxiao_org_members,
            list_yunxiao_test_plans,
            list_yunxiao_test_repos,
            list_yunxiao_testcase_directories,
            search_yunxiao_testcases,
            get_yunxiao_testcase,
            chat_completion,
            verify_model_provider,
            list_ai_sessions,
            create_ai_session,
            read_ai_session,
            update_ai_session,
            set_ai_session_archived,
            delete_ai_session,
            append_ai_session_message,
            save_ai_session_image,
            read_ai_session_attachment,
            run_ai_session_tool,
            read_ai_session_file,
            read_ai_session_xmind,
            write_ai_session_xmind,
            write_ai_session_xmind_with_records,
            write_ai_session_xmind_approved,
            run_approved_ai_session_tool,
            request_ai_approval,
            decide_ai_approval,
            chat_completion_with_tools,
            chat_completion_stream,
            cancel_ai_session_run,
            update_ai_session_memory,
            list_ai_session_runs,
            plan_ai_session_restore,
            apply_ai_session_restore,
            agent::agent_start_turn,
            agent::agent_resume,
            agent::agent_decide,
            agent::agent_stop,
            agent::agent_snapshot,
            agent::agent_active_sessions,
            agent::agent_pending_client_requests,
            agent::agent_respond_client_tool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
