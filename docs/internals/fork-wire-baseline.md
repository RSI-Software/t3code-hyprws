# Fork wire baseline

These wire-shape changes shipped before `fork:delta --check` enforced compatibility.
The baseline prevents old stack commits from blocking new work; it never approves a new change.

| Key                                                                                                      | Reason                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| ipc.ts: desktop IPC shape changed: feat(desktop): open project windows from renderer IPC                 | shipped before the wire check |
| ipc.ts: desktop IPC shape changed: fix(desktop): project windows keep Settings, PRs, and Usage in-window | shipped before the wire check |
| ServerSettings: field removed: zmuxSessions                                                              | shipped before the wire check |
| ServerSettings: field removed: terminalSessionMode                                                       | shipped before the wire check |
| ServerSettingsPatch: field removed: zmuxSessions                                                         | shipped before the wire check |
| ThreadEnvMode: literal added: worktrunk                                                                  | shipped before the wire check |
| OrchestrationProjectShell: field removed: worktrunkHooks                                                 | shipped before the wire check |
| ProjectMetaUpdatedPayload: field removed: worktrunkHooks                                                 | shipped before the wire check |
| ServerSettingsPatch: field removed: worktrunkHooks                                                       | shipped before the wire check |
| T3ProjectFile: field removed: worktrunkHooks                                                             | shipped before the wire check |
| EnvironmentInternalErrorReason: literal added: orchestration_agent_activity_failed                       | shipped before the wire check |
| EnvironmentResourceNotFoundReason: literal added: agent_not_found                                        | shipped before the wire check |
| SidebarThreadSortOrder: literal added: manual                                                            | shipped before the wire check |
| EnvironmentRequestInvalidReason: literal added: invalid_agent_activity_cursor                            | shipped before the wire check |
| EnvironmentInternalErrorReason: literal added: thread_group_title_generation_failed                      | shipped before the wire check |
| EnvironmentResourceNotFoundReason: literal added: project_not_found                                      | shipped before the wire check |
