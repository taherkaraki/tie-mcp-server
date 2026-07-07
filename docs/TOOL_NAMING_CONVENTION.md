# MCP Tool Naming Convention

## Naming Pattern

Format: `{verb}_{resource}[_qualifier]`

### Verbs by HTTP Method

| HTTP Method | MCP Tool Verb | Example |
|-------------|---------------|---------|
| GET (single) | `get` | `get_alert` |
| GET (list) | `list` | `list_alerts` |
| POST (create) | `create` | `create_dashboard` |
| POST (search) | `search` | `search_events` |
| POST (action) | `{action}` | `commit_profile`, `test_email_notifier` |
| PATCH | `update` | `update_alert` |
| PUT | `set` | `set_widget_options` |
| DELETE | `delete` | `delete_dashboard` |

## Tool Categories by Security Level

### 🟢 Safe (Read-Only)
**Pattern**: `get_*`, `list_*`, `search_*`, `export_*`

Examples:
- `get_about`
- `list_attacks`
- `search_events`
- `export_checker_data`

### 🟡 Moderate (Create/Update)
**Pattern**: `create_*`, `update_*`, `set_*`, `patch_*`

Examples:
- `create_dashboard`
- `update_deviance`
- `set_role_permissions`

### 🔴 Dangerous (Delete/Destructive)
**Pattern**: `delete_*`, `unstage_*`

Examples:
- `delete_infrastructure`
- `delete_user`
- `unstage_profile`

## Full Tool List (88 Tools)

### About
- `get_about`

### AD Objects
- `list_ad_objects`
- `get_ad_object_by_directory`
- `get_ad_object_by_infrastructure`
- `get_ad_object_in_event`
- `get_ad_object_changes`
- `get_ad_object_by_checker`
- `search_ad_objects`

### Alerts
- `get_alert`
- `update_alert`
- `list_profile_alerts`
- `update_profile_alerts`

### API Keys
- `get_api_key`
- `create_api_key`

### Application Settings
- `get_application_settings`
- `update_application_settings`

### Attack Types
- `list_attack_types`
- `get_attack_type_configuration`
- `update_attack_type_configuration`
- `list_attack_type_options`
- `create_attack_type_option`

### Attacks (IoA)
- `list_attacks`
- `export_attacks`

### Authentication
- `login`
- `logout`

### Categories
- `list_categories`
- `get_category`

### Checkers (IoE)
- `list_checkers`
- `get_checker`
- `export_checker_data`
- `list_checker_options`
- `create_checker_option`
- `list_checker_reasons`
- `list_checker_deviances`

### Cloud Statistics
- `get_cloud_statistics`

### Dashboards
- `list_dashboards`
- `create_dashboard`
- `get_dashboard`
- `update_dashboard`
- `delete_dashboard`

### Deviances (IoE)
- `list_changed_deviances`
- `get_deviance_by_directory`
- `list_deviances`
- `get_deviance`
- `update_deviance`
- `bulk_update_checker_deviances`
- `create_checker_deviances`
- `update_ad_object_deviances`
- `create_ad_object_deviances`
- `create_event_deviances`

### Directories
- `list_directories`
- `create_directory`
- `get_directory`
- `list_infrastructure_directories`
- `get_infrastructure_directory`
- `update_directory`
- `delete_directory`

### Email Notifiers
- `list_email_notifiers`
- `create_email_notifier`
- `get_email_notifier`
- `update_email_notifier`
- `delete_email_notifier`
- `test_email_notifier`
- `get_email_test_status`

### Events
- `search_events`
- `get_event_by_directory`
- `get_event`
- `list_event_reasons`

### Infrastructures
- `list_infrastructures`
- `create_infrastructure`
- `get_infrastructure`
- `update_infrastructure`
- `delete_infrastructure`

### LDAP Configuration
- `get_ldap_configuration`
- `update_ldap_configuration`

### License
- `get_license`
- `update_license`
- `get_product_association`

### Lockout Policy
- `get_lockout_policy`
- `update_lockout_policy`

### Metrics
- `get_metrics`

### Preferences
- `get_preferences`
- `update_preferences`

### Profiles
- `list_profiles`
- `create_profile`
- `clone_profile`
- `get_profile`
- `update_profile`
- `delete_profile`
- `commit_profile`
- `unstage_profile`
- `get_profile_scores`
- `get_profile_topology`

### Reasons
- `list_reasons`
- `get_reason`

### Relays
- `get_relay_linking_key`

### Report Access Token
- `get_report_access_token`
- `refresh_report_access_token`

### Roles
- `list_roles`
- `create_role`
- `clone_role`
- `get_user_creation_defaults`
- `get_role`
- `update_role`
- `delete_role`
- `set_role_permissions`

### SAML Configuration
- `get_saml_configuration`
- `update_saml_configuration`
- `generate_saml_certificate`

### Syslogs
- `list_syslogs`
- `create_syslog`
- `get_syslog`
- `update_syslog`
- `delete_syslog`
- `test_syslog`
- `get_syslog_test_status`

### Users
- `list_users`
- `create_user`
- `get_current_user`
- `get_user`
- `update_user`
- `delete_user`
- `change_password`
- `set_user_roles`

### Widgets
- `list_widgets`
- `create_widget`
- `get_widget`
- `update_widget`
- `delete_widget`
- `get_widget_options`
- `set_widget_options`

## Implementation Notes

1. **Auto-generation**: Tool names can be generated from OpenAPI spec:
   - Use `operationId` if present
   - Otherwise derive from path + method
   
2. **Parameter naming**: Use camelCase matching OpenAPI schemas

3. **Return types**: Generate TypeScript interfaces from OpenAPI schemas

4. **Error handling**: Standardize error responses across all tools

5. **Documentation**: Each tool gets JSDoc from OpenAPI description
