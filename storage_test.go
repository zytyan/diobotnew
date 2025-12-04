package main

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *PersistentStore {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	store, err := NewPersistentStore(dbPath)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	t.Cleanup(func() {
		_ = store.db.Close()
	})
	return store
}

func TestUpsertUserVerification(t *testing.T) {
	store := newTestStore(t)

	if err := store.UpsertUserVerification(123, "alice", StatusVerifying); err != nil {
		t.Fatalf("insert failed: %v", err)
	}
	if err := store.UpsertUserVerification(123, "alice_new", StatusSuccess); err != nil {
		t.Fatalf("update failed: %v", err)
	}

	row := store.db.QueryRow("SELECT username, status FROM user_verifications WHERE user_id = ?", 123)
	var username string
	var status VerificationStatus
	if err := row.Scan(&username, &status); err != nil {
		t.Fatalf("scan failed: %v", err)
	}
	if username != "alice_new" {
		t.Fatalf("expected username alice_new, got %s", username)
	}
	if status != StatusSuccess {
		t.Fatalf("expected status %s, got %s", StatusSuccess, status)
	}
}

func TestGroupConfigDefaultsAndUpsert(t *testing.T) {
	store := newTestStore(t)

	cfg, err := store.GetOrCreateGroupConfig(1000)
	if err != nil {
		t.Fatalf("get default config failed: %v", err)
	}
	if cfg.ChatID != 1000 || cfg.RequireFollowupMessage {
		t.Fatalf("unexpected default config: %+v", cfg)
	}
	if cfg.VerificationTimeout() != 6*time.Minute {
		t.Fatalf("unexpected default verification timeout: %v", cfg.VerificationTimeout())
	}
	if cfg.BanCooldown() != 10*time.Minute {
		t.Fatalf("unexpected default ban cooldown: %v", cfg.BanCooldown())
	}
	if cfg.KickGracePeriod() != 10*time.Minute {
		t.Fatalf("unexpected default kick grace period: %v", cfg.KickGracePeriod())
	}

	updated := GroupConfig{
		ChatID:                     1000,
		RequireFollowupMessage:     true,
		VerificationTimeoutSeconds: 30,
		FailureBanCooldownSeconds:  45,
		KickGracePeriodSeconds:     50,
	}
	if err := store.UpsertGroupConfig(updated); err != nil {
		t.Fatalf("upsert config failed: %v", err)
	}

	cfg, err = store.GetOrCreateGroupConfig(1000)
	if err != nil {
		t.Fatalf("get updated config failed: %v", err)
	}
	if !cfg.RequireFollowupMessage {
		t.Fatalf("expected followup message requirement to be true")
	}
	if cfg.VerificationTimeout() != 30*time.Second || cfg.BanCooldown() != 45*time.Second || cfg.KickGracePeriod() != 50*time.Second {
		t.Fatalf("unexpected updated durations: vt=%v, ban=%v, kick=%v", cfg.VerificationTimeout(), cfg.BanCooldown(), cfg.KickGracePeriod())
	}
}

func TestPendingGroupLifecycle(t *testing.T) {
	store := newTestStore(t)

	if err := store.AddPendingGroup(1, 10); err != nil {
		t.Fatalf("add pending group failed: %v", err)
	}
	if err := store.AddPendingGroup(1, 11); err != nil {
		t.Fatalf("add second pending group failed: %v", err)
	}

	count := func() int {
		row := store.db.QueryRow("SELECT COUNT(*) FROM pending_groups WHERE user_id = ?", 1)
		var c int
		if err := row.Scan(&c); err != nil {
			t.Fatalf("count scan failed: %v", err)
		}
		return c
	}

	if c := count(); c != 2 {
		t.Fatalf("expected 2 pending groups, got %d", c)
	}

	if err := store.DeletePendingGroupsByUser(1); err != nil {
		t.Fatalf("delete pending groups failed: %v", err)
	}
	if c := count(); c != 0 {
		t.Fatalf("expected 0 pending groups after delete, got %d", c)
	}
}

func TestNilStoreErrors(t *testing.T) {
	var store *PersistentStore
	if err := store.UpsertUserVerification(1, "", StatusFailed); err == nil {
		t.Fatal("expected error on nil store for UpsertUserVerification")
	}
	if err := store.UpsertGroupConfig(GroupConfig{ChatID: 1}); err == nil {
		t.Fatal("expected error on nil store for UpsertGroupConfig")
	}
	if _, err := store.GetOrCreateGroupConfig(1); err == nil {
		t.Fatal("expected error on nil store for GetOrCreateGroupConfig")
	}
	if err := store.AddPendingGroup(1, 1); err == nil {
		t.Fatal("expected error on nil store for AddPendingGroup")
	}
	if err := store.DeletePendingGroupsByUser(1); err == nil {
		t.Fatal("expected error on nil store for DeletePendingGroupsByUser")
	}
}

func TestInitTablesIdempotent(t *testing.T) {
	store := newTestStore(t)
	if err := store.initTables(); err != nil {
		t.Fatalf("initTables not idempotent: %v", err)
	}

	if _, err := store.db.Exec("INSERT INTO user_verifications (user_id, username, status) VALUES (?,?,?)", 99, "foo", StatusVerifying); err != nil {
		t.Fatalf("insert failed after re-init: %v", err)
	}
	if err := store.initTables(); err != nil {
		t.Fatalf("initTables failed after data insert: %v", err)
	}

	var exists bool
	row := store.db.QueryRow("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_groups')")
	if err := row.Scan(&exists); err != nil {
		t.Fatalf("scan exists failed: %v", err)
	}
	if !exists {
		t.Fatal("expected pending_groups table to exist")
	}
}

func TestNewPersistentStoreSetsPragmas(t *testing.T) {
	store := newTestStore(t)

	row := store.db.QueryRow("PRAGMA journal_mode;")
	var mode string
	if err := row.Scan(&mode); err != nil {
		t.Fatalf("scan pragma failed: %v", err)
	}
	if mode != "wal" {
		t.Fatalf("expected WAL journal mode, got %s", mode)
	}

	// ensure connection settings applied
	stats := store.db.Stats()
	if stats.MaxOpenConnections != 1 {
		t.Fatalf("expected MaxOpenConnections 1, got %d", stats.MaxOpenConnections)
	}
	if stats.MaxIdleClosed != 0 {
		t.Fatalf("expected MaxIdleClosed to be 0 before Close, got %d", stats.MaxIdleClosed)
	}
}

func TestNewPersistentStoreError(t *testing.T) {
	// invalid path should fail
	if _, err := NewPersistentStore("/root/does/not/exist/test.db"); err == nil {
		t.Fatal("expected error creating store with invalid path")
	}
}

// Ensure sql import used in tests
var _ sql.DB
