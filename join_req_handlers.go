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
	done              chan struct{}
	deleteTimer       *time.Timer
	verifyFailedTimer *time.Timer
	UserId            int64
	ReqTime           time.Time
	CurrentState      UserJoinState
}

func (u *UserJoinEvent) Init(userId int64) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.UserId = userId
	u.ReqTime = time.Now()
	u.done = make(chan struct{})
	u.deleteTimer = time.AfterFunc(time.Hour*12, func() {
		// 状态最多保存12小时
		userStatus.Delete(userId)
		close(u.done)
	})
	u.verifyFailedTimer = time.AfterFunc(time.Minute*6, func() {
		u.SetState(userVerifyFailed)
	})
}

func (u *UserJoinEvent) SetState(state UserJoinState) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if state == u.CurrentState {
		return
	}
	u.verifyFailedTimer.Stop()
	u.CurrentState = state
	close(u.done)
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

func JoinRequestsHandler(bot *gotgbot.Bot, ctx *ext.Context) error {
	req := ctx.ChatJoinRequest
	chatId := req.UserChatId
	if chatId == 0 {
		return nil
	}
	event, load := userStatus.LoadOrStore(req.From.Id, &UserJoinEvent{})
	if !load {
		event.Init(req.From.Id)
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
