# Tenable Identity Exposure API - Endpoint Reference

## Authentication
- **Method**: API Key
- **Header**: `x-api-key`
- **Base URL**: `https://{customer}.tenable.ad`

## All Endpoints (88 total)

### About
- `GET /api/about` - System information

### AD Objects
- `GET /api/ad-objects` - List AD objects
- `GET /api/directories/{directoryId}/ad-objects/{id}` - Get AD object by directory
- `GET /api/infrastructures/{infrastructureId}/directories/{directoryId}/ad-objects/{id}` - Get AD object by infrastructure
- `GET /api/infrastructures/{infrastructureId}/directories/{directoryId}/events/{eventId}/ad-objects/{id}` - Get AD object in event context
- `GET /api/infrastructures/{infrastructureId}/directories/{directoryId}/events/{eventId}/ad-objects/{id}/changes` - Get AD object changes
- `GET /api/profiles/{profileId}/checkers/{checkerId}/ad-objects/{id}` - Get AD object by checker
- `POST /api/profiles/{profileId}/checkers/{checkerId}/ad-objects/search` - Search AD objects

### Alerts
- `GET /api/alerts/{id}` - Get alert
- `PATCH /api/alerts/{id}` - Update alert
- `GET /api/profiles/{profileId}/alerts` - List alerts for profile
- `PATCH /api/profiles/{profileId}/alerts` - Update alerts for profile

### API Keys
- `GET /api/api-key` - Get API key
- `POST /api/api-key` - Create API key

### Application Settings
- `GET /api/application-settings` - Get settings
- `PATCH /api/application-settings` - Update settings

### Attack Types
- `GET /api/attack-types` - List attack types
- `GET /api/attack-type-configuration` - Get attack type config
- `PATCH /api/attack-type-configuration` - Update attack type config
- `GET /api/profiles/{profileId}/attack-types/{attackTypeId}/attack-type-options` - Get attack type options
- `POST /api/profiles/{profileId}/attack-types/{attackTypeId}/attack-type-options` - Create attack type options

### Attacks (IoA)
- `GET /api/profiles/{profileId}/attacks` - List attacks
- `GET /api/profiles/{profileId}/attacks/export` - Export attacks

### Categories
- `GET /api/categories` - List categories
- `GET /api/categories/{id}` - Get category

### Checkers (IoE)
- `GET /api/checkers` - List checkers
- `GET /api/checkers/{id}` - Get checker
- `GET /api/export/profiles/{profileId}/checkers/{checkerId}` - Export checker data
- `GET /api/profiles/{profileId}/checkers/{checkerId}/checker-options` - Get checker options
- `POST /api/profiles/{profileId}/checkers/{checkerId}/checker-options` - Create checker options
- `GET /api/profiles/{profileId}/checkers/{checkerId}/reasons` - Get reasons
- `GET /api/profiles/{profileId}/infrastructures/{infrastructureId}/directories/{directoryId}/checkers/{checkerId}/deviances` - Get checker deviances

### Cloud Statistics
- `GET /api/cloud-statistics` - Get cloud statistics

### Dashboards
- `GET /api/dashboards` - List dashboards
- `POST /api/dashboards` - Create dashboard
- `GET /api/dashboards/{id}` - Get dashboard
- `PATCH /api/dashboards/{id}` - Update dashboard
- `DELETE /api/dashboards/{id}` - Delete dashboard

### Widgets
- `GET /api/dashboards/{dashboardId}/widgets` - List widgets
- `POST /api/dashboards/{dashboardId}/widgets` - Create widget
- `GET /api/dashboards/{dashboardId}/widgets/{id}` - Get widget
- `PATCH /api/dashboards/{dashboardId}/widgets/{id}` - Update widget
- `DELETE /api/dashboards/{dashboardId}/widgets/{id}` - Delete widget
- `GET /api/dashboards/{dashboardId}/widgets/{id}/options` - Get widget options
- `PUT /api/dashboards/{dashboardId}/widgets/{id}/options` - Update widget options

### Deviances (IoE)
- `GET /api/deviances/changed` - Get changed deviances
- `GET /api/directories/{directoryId}/deviances/{id}` - Get deviance by directory
- `GET /api/infrastructures/{infrastructureId}/directories/{directoryId}/deviances` - List deviances
- `GET /api/infrastructures/{infrastructureId}/directories/{directoryId}/deviances/{id}` - Get deviance
- `PATCH /api/infrastructures/{infrastructureId}/directories/{directoryId}/deviances/{id}` - Update deviance
- `PATCH /api/profiles/{profileId}/checkers/{checkerId}/deviances` - Bulk update deviances
- `POST /api/profiles/{profileId}/checkers/{checkerId}/deviances` - Create deviances
- `PATCH /api/profiles/{profileId}/checkers/{checkerId}/ad-objects/{adObjectId}/deviances` - Update AD object deviances
- `POST /api/profiles/{profileId}/checkers/{checkerId}/ad-objects/{adObjectId}/deviances` - Create AD object deviances
- `POST /api/profiles/{profileId}/infrastructures/{infrastructureId}/directories/{directoryId}/events/{eventId}/deviances` - Create event deviances

### Directories
- `GET /api/directories` - List directories
- `POST /api/directories` - Create directory
- `GET /api/directories/{id}` - Get directory
- `GET /api/infrastructures/{infrastructureId}/directories` - List directories by infrastructure
- `GET /api/infrastructures/{infrastructureId}/directories/{id}` - Get directory by infrastructure
- `PATCH /api/infrastructures/{infrastructureId}/directories/{id}` - Update directory
- `DELETE /api/infrastructures/{infrastructureId}/directories/{id}` - Delete directory

### Email Notifiers
- `GET /api/email-notifiers` - List email notifiers
- `POST /api/email-notifiers` - Create email notifier
- `GET /api/email-notifiers/{id}` - Get email notifier
- `PATCH /api/email-notifiers/{id}` - Update email notifier
- `DELETE /api/email-notifiers/{id}` - Delete email notifier
- `POST /api/email-notifiers/test-message` - Send test message
- `GET /api/email-notifiers/test-message/{id}` - Get test message status

### Events
- `POST /api/events/search` - Search events
- `GET /api/directories/{directoryId}/events/{id}` - Get event by directory
- `GET /api/infrastructures/{infrastructureId}/directories/{directoryId}/events/{id}` - Get event
- `GET /api/profiles/{profileId}/infrastructures/{infrastructureId}/directories/{directoryId}/events/{eventId}/reasons` - Get event reasons

### Infrastructures
- `GET /api/infrastructures` - List infrastructures
- `POST /api/infrastructures` - Create infrastructure
- `GET /api/infrastructures/{id}` - Get infrastructure
- `PATCH /api/infrastructures/{id}` - Update infrastructure
- `DELETE /api/infrastructures/{id}` - Delete infrastructure

### LDAP Configuration
- `GET /api/ldap-configuration` - Get LDAP config
- `PATCH /api/ldap-configuration` - Update LDAP config

### License
- `GET /api/license` - Get license
- `POST /api/license` - Update license
- `GET /api/license/product-association` - Get product association

### Lockout Policy
- `GET /api/lockout-policy` - Get lockout policy
- `PATCH /api/lockout-policy` - Update lockout policy

### Authentication
- `POST /api/login` - Login
- `POST /api/logout` - Logout

### Metrics
- `GET /api/metrics` - Get metrics

### Preferences
- `GET /api/preferences` - Get preferences
- `PATCH /api/preferences` - Update preferences

### Profiles
- `GET /api/profiles` - List profiles
- `POST /api/profiles` - Create profile
- `POST /api/profiles/from/{fromId}` - Clone profile
- `GET /api/profiles/{id}` - Get profile
- `PATCH /api/profiles/{id}` - Update profile
- `DELETE /api/profiles/{id}` - Delete profile
- `POST /api/profiles/{id}/commit` - Commit profile
- `POST /api/profiles/{id}/unstage` - Unstage profile
- `GET /api/profiles/{profileId}/scores` - Get scores
- `GET /api/profiles/{profileId}/topology` - Get topology

### Reasons
- `GET /api/reasons` - List reasons
- `GET /api/reasons/{id}` - Get reason

### Relays
- `GET /api/relays/linking-key` - Get relay linking key

### Report Access Token
- `GET /api/report-access-token` - Get report access token
- `POST /api/report-access-token/refresh` - Refresh token

### Roles
- `GET /api/roles` - List roles
- `POST /api/roles` - Create role
- `POST /api/roles/from/{fromId}` - Clone role
- `GET /api/roles/user-creation-defaults` - Get user creation defaults
- `GET /api/roles/{id}` - Get role
- `PATCH /api/roles/{id}` - Update role
- `DELETE /api/roles/{id}` - Delete role
- `PUT /api/roles/{id}/permissions` - Update permissions

### SAML Configuration
- `GET /api/saml-configuration` - Get SAML config
- `PATCH /api/saml-configuration` - Update SAML config
- `GET /api/saml-configuration/generate-certificate` - Generate certificate

### Syslogs
- `GET /api/syslogs` - List syslog configs
- `POST /api/syslogs` - Create syslog config
- `GET /api/syslogs/{id}` - Get syslog config
- `PATCH /api/syslogs/{id}` - Update syslog config
- `DELETE /api/syslogs/{id}` - Delete syslog config
- `POST /api/syslogs/test-message` - Send test message
- `GET /api/syslogs/test-message/{id}` - Get test message status

### Users
- `GET /api/users` - List users
- `POST /api/users` - Create user
- `GET /api/users/whoami` - Get current user
- `GET /api/users/{id}` - Get user
- `PATCH /api/users/{id}` - Update user
- `DELETE /api/users/{id}` - Delete user
- `PATCH /api/users/password` - Change password
- `PUT /api/users/{id}/roles` - Update user roles
