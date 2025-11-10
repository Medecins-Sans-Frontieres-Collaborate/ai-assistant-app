# Migration Testing Guide

## Overview

This guide provides comprehensive testing procedures for the localStorage → Zustand migration feature.

## Migration Strategy

- **Safe Copy-Only**: Old data is copied to new format, never deleted
- **Automatic**: Runs silently in background on app initialization
- **Idempotent**: Can run multiple times safely
- **Non-blocking**: App works even if migration fails
- **Backup**: Creates permanent backup before migration

---

## Automated Tests

Run the test suite:

```bash
npm run test:node migration
```

Or run the specific test file:

```bash
npx vitest --run __tests__/node/services/migration.test.ts --config ./vitest.config.node.mts
```

---

## Manual Testing Scenarios

### Prerequisites

1. Open browser DevTools (F12)
2. Go to Application → Local Storage
3. Keep Console tab open to see migration logs

---

### Test 1: Fresh Install (No Migration Needed)

**Purpose**: Verify new users work normally

**Steps**:

1. Clear all localStorage: `localStorage.clear()`
2. Reload page
3. Create a conversation
4. Check localStorage

**Expected**:

- ✅ No migration runs (no "🔄 Starting migration" log)
- ✅ New stores exist: `settings-storage`, `conversation-storage`, `ui-storage`
- ✅ No migration flag set yet
- ✅ App works normally

---

### Test 2: Basic Settings Migration

**Purpose**: Verify settings migrate correctly

**Steps**:

1. Clear all localStorage
2. Set old format in Console:

```javascript
localStorage.setItem('temperature', '0.8');
localStorage.setItem('systemPrompt', 'You are a helpful assistant');
localStorage.setItem('theme', 'light');
```

3. Reload page

**Expected**:

- ✅ Console shows: "🔄 Starting automatic data migration..."
- ✅ Console shows: "✓ Backup created"
- ✅ Console shows: "✓ Settings migrated"
- ✅ Console shows: "✅ Migration complete!"
- ✅ `settings-storage` exists with correct data:
  ```javascript
  JSON.parse(localStorage.getItem('settings-storage'));
  // Should show: { state: { temperature: 0.8, systemPrompt: "You are...", ... }, version: 1 }
  ```
- ✅ OLD data still exists: `localStorage.getItem('temperature')` → `"0.8"`
- ✅ Backup exists: `localStorage.getItem('data_migration_backup')`
- ✅ Flag set: `localStorage.getItem('data_migration_v2_complete')` → `"true"`

---

### Test 3: Conversation Migration

**Purpose**: Verify conversations and folders migrate

**Steps**:

1. Clear localStorage
2. Set old conversations:

```javascript
const conversations = [
  {
    id: 'conv1',
    name: 'Test Chat 1',
    model: { id: 'gpt-4' },
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ],
    folderId: 'folder1',
  },
];

const folders = [{ id: 'folder1', name: 'Work', type: 'chat' }];

localStorage.setItem('conversations', JSON.stringify(conversations));
localStorage.setItem('folders', JSON.stringify(folders));
localStorage.setItem('selectedConversationId', 'conv1');
```

3. Reload page

**Expected**:

- ✅ Console shows: "✓ Migrated 1 conversations"
- ✅ `conversation-storage` contains the data:
  ```javascript
  JSON.parse(localStorage.getItem('conversation-storage'));
  // Should show conversations array, folders array, selectedConversationId
  ```
- ✅ Conversations appear in UI sidebar
- ✅ Selected conversation is active
- ✅ Old data still exists in localStorage

---

### Test 4: Alternate Key Migration (conversationHistory)

**Purpose**: Verify legacy alternate key works

**Steps**:

1. Clear localStorage
2. Use old alternate key:

```javascript
const convs = [{ id: '1', name: 'Chat', messages: [] }];
localStorage.setItem('conversationHistory', JSON.stringify(convs));
```

3. Reload page

**Expected**:

- ✅ Migration succeeds
- ✅ Conversations appear in UI
- ✅ Both old keys preserved: `conversationHistory` and `conversation-storage`

---

### Test 5: Skip If Already Migrated

**Purpose**: Verify migration doesn't re-run

**Steps**:

1. Clear localStorage
2. Set migration flag manually:

```javascript
localStorage.setItem('data_migration_v2_complete', 'true');
localStorage.setItem('temperature', '0.7');
```

3. Reload page

**Expected**:

- ✅ NO migration logs appear
- ✅ App works normally
- ✅ Old data remains untouched

---

### Test 6: Skip If New Format Already Exists

**Purpose**: Verify existing data isn't overwritten

**Steps**:

1. Clear localStorage
2. Create new format manually:

```javascript
const newSettings = {
  state: { temperature: 0.9, systemPrompt: 'New', prompts: [] },
  version: 1,
};
localStorage.setItem('settings-storage', JSON.stringify(newSettings));
// Also add old format
localStorage.setItem('temperature', '0.5');
```

3. Reload page

**Expected**:

- ✅ Console shows: "✓ Settings already in new format, skipping"
- ✅ New format temperature remains 0.9 (NOT overwritten to 0.5)
- ✅ Migration completes successfully

---

### Test 7: Partial Migration (Mixed Data)

**Purpose**: Verify each store migrates independently

**Steps**:

1. Clear localStorage
2. Set mixed old/new format:

```javascript
// Old settings
localStorage.setItem('temperature', '0.7');

// NEW conversations (already migrated)
const convData = {
  state: { conversations: [{ id: '1', name: 'Existing' }], folders: [] },
  version: 1,
};
localStorage.setItem('conversation-storage', JSON.stringify(convData));

// Old theme
localStorage.setItem('theme', 'dark');
```

3. Reload page

**Expected**:

- ✅ Settings migrate: "✓ Settings migrated"
- ✅ Conversations skip: "✓ Conversations already in new format, skipping"
- ✅ UI migrates: "✓ UI settings migrated"
- ✅ All stores work correctly

---

### Test 8: Empty Values

**Purpose**: Verify handling of empty/null data

**Steps**:

1. Clear localStorage
2. Set empty values:

```javascript
localStorage.setItem('conversations', '[]');
localStorage.setItem('prompts', '[]');
localStorage.setItem('selectedConversationId', 'null');
```

3. Reload page

**Expected**:

- ✅ Migration succeeds
- ✅ Empty arrays preserved: `[]`
- ✅ Null values preserved: `null`
- ✅ No errors in console

---

### Test 9: Large Dataset

**Purpose**: Verify performance with many conversations

**Steps**:

1. Clear localStorage
2. Create 100 conversations:

```javascript
const manyConvs = [];
for (let i = 0; i < 100; i++) {
  manyConvs.push({
    id: `conv${i}`,
    name: `Chat ${i}`,
    model: { id: 'gpt-4' },
    messages: [
      { role: 'user', content: `Message ${i}` },
      { role: 'assistant', content: `Response ${i}` },
    ],
  });
}
localStorage.setItem('conversations', JSON.stringify(manyConvs));
```

3. Reload page

**Expected**:

- ✅ Console shows: "✓ Migrated 100 conversations"
- ✅ Migration completes in < 1 second
- ✅ All conversations appear in UI
- ✅ No performance issues

---

### Test 10: Backup Verification

**Purpose**: Verify backup contains correct data

**Steps**:

1. Clear localStorage
2. Set various old data
3. Reload and migrate
4. Check backup:

```javascript
const backup = JSON.parse(localStorage.getItem('data_migration_backup'));
console.log('Backup timestamp:', new Date(backup.timestamp));
console.log('Backup data:', backup.data);
```

**Expected**:

- ✅ Backup exists
- ✅ Contains `timestamp` (number)
- ✅ Contains `date` (ISO string)
- ✅ Contains `data` object with all old keys
- ✅ Backup data is valid JSON

---

### Test 11: Multiple Page Reloads

**Purpose**: Verify idempotency

**Steps**:

1. Complete a migration (any test above)
2. Reload page 5 times
3. Check console each time

**Expected**:

- ✅ First load: Full migration runs
- ✅ Subsequent loads: NO migration (skipped)
- ✅ Data remains consistent
- ✅ No errors

---

### Test 12: Concurrent Tabs

**Purpose**: Verify behavior with multiple tabs

**Steps**:

1. Clear localStorage
2. Set old data
3. Open 3 tabs simultaneously
4. Reload all tabs at once

**Expected**:

- ✅ First tab to load migrates
- ✅ Other tabs skip (see flag set)
- ✅ All tabs work correctly
- ✅ No duplicate data

---

### Test 13: App Functionality After Migration

**Purpose**: Verify app works correctly post-migration

**Steps**:

1. Complete migration with conversations
2. Test all features:
   - Create new conversation
   - Send message
   - Edit conversation name
   - Delete conversation
   - Change settings
   - Toggle theme
   - Create folder
   - Export data

**Expected**:

- ✅ All features work normally
- ✅ New data saves to Zustand stores
- ✅ Old localStorage keys remain untouched
- ✅ No errors in console

---

### Test 14: Error Handling (Corrupted Data)

**Purpose**: Verify graceful failure

**Steps**:

1. Clear localStorage
2. Set invalid JSON:

```javascript
localStorage.setItem('conversations', 'INVALID_JSON{not valid}');
localStorage.setItem('temperature', '0.7');
```

3. Reload page

**Expected**:

- ✅ Console shows: "Conversation migration error: ..."
- ✅ Other stores still migrate successfully
- ✅ App continues to work
- ✅ User can still use app with defaults

---

### Test 15: Browser Compatibility

**Purpose**: Verify works across browsers

**Repeat Tests 2, 3, 4 in**:

- Chrome
- Firefox
- Safari
- Edge

**Expected**:

- ✅ Same behavior in all browsers
- ✅ No browser-specific errors

---

## Verification Checklist

After running tests, verify:

- [ ] Migration creates correct Zustand format (version: 1)
- [ ] Only persisted fields included (no isLoaded, isSettingsOpen, models)
- [ ] Correct defaults used (theme: 'dark', showChatbar: false, etc.)
- [ ] Old data never deleted
- [ ] Backup created
- [ ] Flag prevents re-migration
- [ ] No errors in production build
- [ ] Performance acceptable (< 1s for 100 conversations)
- [ ] Works in all major browsers
- [ ] App functional after migration

---

## Common Issues & Debugging

### Issue: Migration doesn't run

**Check**:

```javascript
localStorage.getItem('data_migration_v2_complete'); // Should be null or missing
LocalStorageService.hasLegacyData(); // Should return true
```

### Issue: Data not appearing after migration

**Check**:

```javascript
// Verify new format exists and is valid
const settings = JSON.parse(localStorage.getItem('settings-storage'));
console.log(settings.version); // Should be 1
console.log(settings.state); // Should contain data
```

### Issue: Migration runs every time

**Check**:

```javascript
localStorage.getItem('data_migration_v2_complete'); // Should be "true"
```

### Clear Everything and Start Fresh

```javascript
localStorage.clear();
location.reload();
```

---

## Success Criteria

Migration is considered successful when:

1. ✅ All automated tests pass
2. ✅ All manual test scenarios pass
3. ✅ No console errors during migration
4. ✅ Old data preserved
5. ✅ New format correct
6. ✅ App fully functional
7. ✅ Backup created
8. ✅ Idempotent behavior verified

---

## Rollback Plan

If critical issues found:

1. **Immediate**: Users can manually export data
2. **Code**: Revert migration code
3. **Data**: Users still have old format intact (never deleted)
4. **Recovery**: Backup always available in `data_migration_backup`
