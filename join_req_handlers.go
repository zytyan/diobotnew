package main

import (
	"fmt"
	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/PaulSonOfLars/gotgbot/v2/ext"
	"github.com/puzpuzpuz/xsync/v4"
	"log"
	"strings"
	"sync"
	"time"
)

type UserJoinState int

const (
	userVerifying UserJoinState = iota
	userVerifySucceed
	userVerifyFailed
)

type UserJoinEvent struct {
	mu                sync.Mutex
	o                 sync.Once
	done              chan struct{}
	deleteTimer       *time.Timer
	verifyFailedTimer *time.Timer
	UserId            int64
	Username          string
	ReqTime           time.Time
	CurrentState      UserJoinState
}

func (u *UserJoinEvent) Init(userId int64, username string, verificationTimeout time.Duration) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.UserId = userId
	u.Username = username
	u.ReqTime = time.Now()
	u.done = make(chan struct{})
	u.deleteTimer = time.AfterFunc(time.Hour*12, func() {
		// 状态最多保存12小时
		userStatus.Delete(userId)
		u.o.Do(func() { close(u.done) })
	})
	timeout := verificationTimeout
	if timeout <= 0 {
		timeout = defaultVerificationTimeout
	}
	u.verifyFailedTimer = time.AfterFunc(timeout, func() {
		u.SetState(userVerifyFailed)
	})
	persistUserVerification(userId, username, userVerifying)
}

func (u *UserJoinEvent) SetState(state UserJoinState) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if state == u.CurrentState {
		return
	}
	u.verifyFailedTimer.Stop()
	u.CurrentState = state
	persistUserVerification(u.UserId, u.Username, state)
	if state != userVerifying {
		cleanupPendingGroups(u.UserId)
	}
	u.o.Do(func() { close(u.done) })
}

func (u *UserJoinEvent) UpdateUsername(username string) {
	if username == "" {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.Username = username
}

func (u *UserJoinEvent) WaitForStateEvent() UserJoinState {
	<-u.done
	return u.CurrentState
}

func (u *UserJoinEvent) String() string {
	state := "未知"
	switch u.CurrentState {
	case userVerifying:
		state = "正在验证"
	case userVerifySucceed:
		state = "验证成功"
	case userVerifyFailed:
		state = "验证失败"
	}
	reqTime := u.ReqTime.Format("2006-01-02 15:04:05")
	return fmt.Sprintf("user %d 于%s开始尝试加入，当前状态 [%s]，", u.UserId, reqTime, state)
}

var userStatus = xsync.NewMap[int64, *UserJoinEvent]()

const defaultVerificationTimeout = time.Minute * 6

func JoinRequestsHandler(bot *gotgbot.Bot, ctx *ext.Context) error {
	req := ctx.ChatJoinRequest
	chatId := req.UserChatId
	if chatId == 0 {
		return nil
	}
	verificationTimeout := defaultVerificationTimeout
	if persistentStore != nil {
		if cfg, err := persistentStore.GetOrCreateGroupConfig(req.Chat.Id); err == nil {
			verificationTimeout = cfg.VerificationTimeout()
		} else {
			log.Printf("加载群组配置失败: %v", err)
		}
	}
	event, loaded := userStatus.LoadOrCompute(req.From.Id, func() (*UserJoinEvent, bool) {
		e := &UserJoinEvent{}
		e.Init(req.From.Id, req.From.Username, verificationTimeout)
		return e, false
	})
	if loaded {
		event.UpdateUsername(req.From.Username)
		persistUserVerification(req.From.Id, req.From.Username, event.CurrentState)
	}
	if err := recordPendingGroup(req.From.Id, req.Chat.Id); err != nil {
		log.Printf("记录待加入群组失败: %v", err)
	}
	text := fmt.Sprintf("点击下方链接验证您是人类\nhttps://t.me/%s?startapp", bot.Username)
	log.Printf("向用户%d发送人类验证消息", req.From.Id)
	_, err := bot.SendMessage(req.UserChatId, text, nil)
	go func() {
		newState := event.WaitForStateEvent()
		switch newState {
		case userVerifying:
			log.Printf("这里不该出现")
		case userVerifySucceed:
			log.Printf("尝试允许用户%d加入", req.From.Id)
			_, err := bot.ApproveChatJoinRequest(req.Chat.Id, req.From.Id, nil)
			if err != nil {
				log.Printf("允许用户%d加入失败: %s", req.From.Id, err)
			}
		case userVerifyFailed:
			log.Printf("尝试拒绝用户%d加入", req.From.Id)
			_, err := bot.DeclineChatJoinRequest(req.Chat.Id, req.From.Id, nil)
			if err != nil {
				log.Printf("拒绝用户%d加入失败: %s", req.From.Id, err)
			}
		}
	}()
	return err
}

func getUserFullName(user *gotgbot.User) string {
	buf := strings.Builder{}
	buf.Grow(len(user.FirstName) + len(user.LastName) + 1)
	buf.WriteString(user.FirstName)
	if len(user.LastName) > 0 {
		buf.WriteString(user.LastName)
	}
	return buf.String()
}

func persistUserVerification(userID int64, username string, state UserJoinState) {
	if persistentStore == nil {
		return
	}
	var status VerificationStatus
	switch state {
	case userVerifySucceed:
		status = StatusSuccess
	case userVerifyFailed:
		status = StatusFailed
	default:
		status = StatusVerifying
	}
	if err := persistentStore.UpsertUserVerification(userID, username, status); err != nil {
		log.Printf("写入用户验证状态失败: %v", err)
	}
}

func cleanupPendingGroups(userID int64) {
	if persistentStore == nil {
		return
	}
	if err := persistentStore.DeletePendingGroupsByUser(userID); err != nil {
		log.Printf("清理待加入群组失败: %v", err)
	}
}

func recordPendingGroup(userID, chatID int64) error {
	if persistentStore == nil {
		return nil
	}
	return persistentStore.AddPendingGroup(userID, chatID)
}
