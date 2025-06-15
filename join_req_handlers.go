package main

import (
	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/PaulSonOfLars/gotgbot/v2/ext"
	"sync"
	"time"
)

type UserJoinState int

const (
	userVerifying UserJoinState = iota
	userVerifySucceed
	userVerifyFailed
	userVerifySilent
)

type UserJoinEvent struct {
	mu           sync.Mutex
	timer        *time.Timer
	UserId       int64
	ReqTime      time.Time
	CurrentState UserJoinState
}

func (u *UserJoinEvent) ResetTimerWithLock() {
	if u.timer != nil {
		u.timer.Stop()
		u.timer = nil
	}
}

var userStatus sync.Map

func JoinRequestsHandler(bot *gotgbot.Bot, ctx *ext.Context) error {
	req := ctx.ChatJoinRequest
	chatId := req.UserChatId
	if chatId == 0 {
		return nil
	}
	// 通过Turnstile生成一个唯一的验证链接， base64(userId, timestamp) 共16字节
	// https://tgv.zchan.moe/verify/[base64(userId, timestamp)]
	// 可以通过bot web自动解决该问题，要比用链接好些，关键只需要点开就OK了
	// 本工具通过 Turnstile 验证您是否是人类，请点击下方链接进行人类验证

	// 链接点击，验证完成后五分钟内有效
	// 然后再发一条消息让新加入的人说话，10分钟内不说话就踢人
	return nil
}

func sendVerifyToUserJoinViaReq(bot *gotgbot.Bot, ctx *ext.Context) error {
	panic("todo")
}

func sendVerifyToUserJoinNotViaReq(bot *gotgbot.Bot, ctx *ext.Context) error {
	panic("todo")
}
