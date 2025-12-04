package main

import (
	"database/sql"
	"errors"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type VerificationStatus string

const (
	StatusVerifying VerificationStatus = "verifying"
	StatusSuccess   VerificationStatus = "success"
	StatusFailed    VerificationStatus = "failed"
)

type PersistentStore struct {
	db *sql.DB
}

type GroupConfig struct {
	ChatID                     int64
	RequireFollowupMessage     bool
	VerificationTimeoutSeconds int
	FailureBanCooldownSeconds  int
	KickGracePeriodSeconds     int
	UpdatedAt                  time.Time
}

func NewPersistentStore(path string) (*PersistentStore, error) {
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		return nil, err
	}
	db.SetConnMaxLifetime(0)
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL;`); err != nil {
		return nil, err
	}
	store := &PersistentStore{db: db}
	if err := store.initTables(); err != nil {
		return nil, err
	}
	return store, nil
}

func (p *PersistentStore) initTables() error {
	schema := []string{
		`CREATE TABLE IF NOT EXISTS user_verifications (
                        user_id INTEGER PRIMARY KEY,
                        username TEXT,
                        status TEXT NOT NULL,
                        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                );`,
		`CREATE TABLE IF NOT EXISTS group_configs (
                        chat_id INTEGER PRIMARY KEY,
                        require_followup_message INTEGER NOT NULL DEFAULT 0,
                        verification_timeout_seconds INTEGER NOT NULL DEFAULT 360,
                        failure_ban_cooldown_seconds INTEGER NOT NULL DEFAULT 600,
                        kick_grace_period_seconds INTEGER NOT NULL DEFAULT 600,
                        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                );`,
		`CREATE TABLE IF NOT EXISTS pending_groups (
                        user_id INTEGER NOT NULL,
                        chat_id INTEGER NOT NULL,
                        requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (user_id, chat_id)
                );`,
	}
	for _, stmt := range schema {
		if _, err := p.db.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}

func (p *PersistentStore) UpsertUserVerification(userID int64, username string, status VerificationStatus) error {
	if p == nil {
		return errors.New("nil persistent store")
	}
	_, err := p.db.Exec(`INSERT INTO user_verifications (user_id, username, status, updated_at)
VALUES (?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, status=excluded.status, updated_at=excluded.updated_at;
`, userID, username, status)
	return err
}

func (p *PersistentStore) UpsertGroupConfig(cfg GroupConfig) error {
	if p == nil {
		return errors.New("nil persistent store")
	}
	_, err := p.db.Exec(`INSERT INTO group_configs (chat_id, require_followup_message, verification_timeout_seconds, failure_ban_cooldown_seconds, kick_grace_period_seconds, updated_at)
VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(chat_id) DO UPDATE SET require_followup_message=excluded.require_followup_message,
        verification_timeout_seconds=excluded.verification_timeout_seconds,
        failure_ban_cooldown_seconds=excluded.failure_ban_cooldown_seconds,
        kick_grace_period_seconds=excluded.kick_grace_period_seconds,
        updated_at=excluded.updated_at;
`, cfg.ChatID, cfg.RequireFollowupMessage, cfg.VerificationTimeoutSeconds, cfg.FailureBanCooldownSeconds, cfg.KickGracePeriodSeconds)
	return err
}

func (p *PersistentStore) GetOrCreateGroupConfig(chatID int64) (GroupConfig, error) {
	if p == nil {
		return GroupConfig{}, errors.New("nil persistent store")
	}
	defaultCfg := GroupConfig{
		ChatID:                     chatID,
		RequireFollowupMessage:     false,
		VerificationTimeoutSeconds: 360,
		FailureBanCooldownSeconds:  600,
		KickGracePeriodSeconds:     600,
	}
	if _, err := p.db.Exec(`INSERT INTO group_configs (chat_id) VALUES (?) ON CONFLICT(chat_id) DO NOTHING;`, chatID); err != nil {
		return GroupConfig{}, err
	}
	row := p.db.QueryRow(`SELECT chat_id, require_followup_message, verification_timeout_seconds, failure_ban_cooldown_seconds, kick_grace_period_seconds, updated_at FROM group_configs WHERE chat_id = ?;`, chatID)
	cfg := GroupConfig{}
	var requireFollowup int
	if err := row.Scan(&cfg.ChatID, &requireFollowup, &cfg.VerificationTimeoutSeconds, &cfg.FailureBanCooldownSeconds, &cfg.KickGracePeriodSeconds, &cfg.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return defaultCfg, nil
		}
		return GroupConfig{}, err
	}
	cfg.RequireFollowupMessage = requireFollowup != 0
	return cfg, nil
}

func (p *PersistentStore) AddPendingGroup(userID, chatID int64) error {
	if p == nil {
		return errors.New("nil persistent store")
	}
	_, err := p.db.Exec(`INSERT INTO pending_groups (user_id, chat_id) VALUES (?, ?) ON CONFLICT(user_id, chat_id) DO UPDATE SET requested_at=CURRENT_TIMESTAMP;`, userID, chatID)
	return err
}

func (p *PersistentStore) DeletePendingGroupsByUser(userID int64) error {
	if p == nil {
		return errors.New("nil persistent store")
	}
	_, err := p.db.Exec(`DELETE FROM pending_groups WHERE user_id = ?;`, userID)
	return err
}

func (g GroupConfig) VerificationTimeout() time.Duration {
	if g.VerificationTimeoutSeconds <= 0 {
		return time.Minute * 6
	}
	return time.Duration(g.VerificationTimeoutSeconds) * time.Second
}

func (g GroupConfig) BanCooldown() time.Duration {
	if g.FailureBanCooldownSeconds <= 0 {
		return time.Minute * 10
	}
	return time.Duration(g.FailureBanCooldownSeconds) * time.Second
}

func (g GroupConfig) KickGracePeriod() time.Duration {
	if g.KickGracePeriodSeconds <= 0 {
		return time.Minute * 10
	}
	return time.Duration(g.KickGracePeriodSeconds) * time.Second
}
