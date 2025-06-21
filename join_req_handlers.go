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
	mu            sync.Mutex
	timer         *time.Timer
	UserId        int64
	ReqTime       time.Time
	JoiningGroups []int64
	CurrentState  UserJoinState
}

func (u *UserJoinEvent) Approve() {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, g := range u.JoiningGroups {
		resp, err := tgBot.ApproveChatJoinRequest(g, u.UserId, nil)
		if !resp || err != nil {
			log.Printf("DeclineChatJoinRequest err %s", err)
		}
	}
}

func (u *UserJoinEvent) Decline() {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, g := range u.JoiningGroups {
		resp, err := tgBot.DeclineChatJoinRequest(g, u.UserId, nil)
		if !resp || err != nil {
			log.Printf("DeclineChatJoinRequest err %s", err)
		}
	}
}

func (u *UserJoinEvent) AddJoiningGroup(group int64) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.JoiningGroups = append(u.JoiningGroups, group)
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
	return fmt.Sprintf("user %d 于%s开始尝试加入%d个群组，当前状态 [%s]，", u.UserId, reqTime, len(u.JoiningGroups), state)
}

var userStatus = xsync.NewMap[int64, *UserJoinEvent]()

func JoinRequestsHandler(bot *gotgbot.Bot, ctx *ext.Context) error {
	req := ctx.ChatJoinRequest
	chatId := req.UserChatId
	if chatId == 0 {
		return nil
	}
	event, load := userStatus.LoadOrStore(req.From.Id, &UserJoinEvent{})
	if load {
		event.AddJoiningGroup(req.Chat.Id)
		switch event.CurrentState {
		case userVerifying:
		case userVerifyFailed:
			event.Decline()
		case userVerifySucceed:
			event.Approve()
		}
		return nil
	}
	event.mu.Lock()
	event.CurrentState = userVerifying
	event.ReqTime = time.Now()
	event.UserId = req.From.Id
	event.timer = time.AfterFunc(time.Hour*12, func() {
		// 状态最多保存12小时
		userStatus.Delete(req.From.Id)
	})
	event.mu.Unlock()
	event.AddJoiningGroup(req.Chat.Id)
	text := fmt.Sprintf("点击下方链接验证人类\nhttps://t.me/%s?startapp=verify", bot.Username)
	log.Printf("向用户%d发送人类验证消息", req.From.Id)
	_, err := bot.SendMessage(req.UserChatId, text, nil)
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
