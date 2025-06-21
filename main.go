package main

import (
	"fmt"
	"github.com/puzpuzpuz/xsync/v4"
	"html"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/PaulSonOfLars/gotgbot/v2/ext"
	"github.com/PaulSonOfLars/gotgbot/v2/ext/handlers"
)

var botToken = os.Getenv("BOT_TOKEN")
var tgBot *gotgbot.Bot

// This bot is as basic as it gets - it simply repeats everything you say.
// The main_test.go file contains example code to demonstrate how to implement the gotgbot.BotClient interface for it to be used in tests.
func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	// Get token from the environment variable
	go initHttp()
	// Create bot from environment value.
	b, err := gotgbot.NewBot(botToken, &gotgbot.BotOpts{
		BotClient: &gotgbot.BaseBotClient{
			Client: http.Client{},
			DefaultRequestOpts: &gotgbot.RequestOpts{
				Timeout: gotgbot.DefaultTimeout, // Customise the default request timeout here
				APIURL:  gotgbot.DefaultAPIURL,  // As well as the Default API URL here (in case of using local bot API servers)
			},
		},
	})
	if err != nil {
		panic("failed to create new bot: " + err.Error())
	}
	tgBot = b
	// Create updater and dispatcher.
	dispatcher := ext.NewDispatcher(&ext.DispatcherOpts{
		// If an error is returned by a handler, log it and continue going.
		Error: func(b *gotgbot.Bot, ctx *ext.Context, err error) ext.DispatcherAction {
			log.Println("an error occurred while handling update:", err.Error())
			return ext.DispatcherActionNoop
		},
		MaxRoutines: ext.DefaultMaxRoutines,
	})
	updater := ext.NewUpdater(dispatcher, nil)

	dispatcher.AddHandler(handlers.NewChatMember(isInvitedByOtherMember, showWelcomeMessageToUserByInvited))
	dispatcher.AddHandler(handlers.NewChatMember(isUserLeft, showGoodbyeMessageToChat))
	dispatcher.AddHandler(handlers.NewChatMember(isUserBanned, showBannedMessageToChat))
	dispatcher.AddHandler(handlers.NewChatMember(isUserJoinedByLink, showWelcomeMessageToUserJoinedByLink))
	dispatcher.AddHandler(handlers.NewMessage(nil, handleAnyNewMsg))
	dispatcher.AddHandler(handlers.NewChatJoinRequest(nil, JoinRequestsHandler))
	// Start receiving updates.
	err = updater.StartPolling(b, &ext.PollingOpts{
		DropPendingUpdates: true,
		GetUpdatesOpts: &gotgbot.GetUpdatesOpts{
			Timeout:        9,
			AllowedUpdates: []string{"message", "my_chat_member", "chat_member", "chat_join_request"},
			RequestOpts: &gotgbot.RequestOpts{
				Timeout: time.Second * 10,
			},
		},
	})
	if err != nil {
		panic("failed to start polling: " + err.Error())
	}
	log.Printf("%s has been started...\n", b.User.Username)

	// Idle, to keep updates coming in, and avoid bot stopping.
	updater.Idle()
}

func isInvitedByOtherMember(u *gotgbot.ChatMemberUpdated) bool {
	_, ok := u.NewChatMember.(gotgbot.ChatMemberMember)
	// 没有邀请链接，就说明是从其他用户邀请来的
	return ok && u.InviteLink == nil
}

func isUserLeft(u *gotgbot.ChatMemberUpdated) bool {
	_, ok := u.NewChatMember.(gotgbot.ChatMemberLeft)
	return ok
}
func isUserJoinedByLink(u *gotgbot.ChatMemberUpdated) bool {
	_, ok := u.NewChatMember.(gotgbot.ChatMemberMember)
	return ok && u.InviteLink != nil
}

func isUserBanned(u *gotgbot.ChatMemberUpdated) bool {
	_, ok := u.NewChatMember.(gotgbot.ChatMemberBanned)
	return ok
}

func showWelcomeMessageToUserByInvited(b *gotgbot.Bot, ctx *ext.Context) error {
	inviter := ctx.ChatMember.OldChatMember.GetUser()
	invitee := ctx.ChatMember.NewChatMember.GetUser()
	text := fmt.Sprintf(`原来是%s先生请来的贵客，%s先生您也请。`, getUserFullName(&inviter), getUserFullName(&invitee))
	_, err := b.SendMessage(ctx.ChatMember.Chat.Id, text, nil)
	return err
}

func showGoodbyeMessageToChat(b *gotgbot.Bot, ctx *ext.Context) error {
	leftUser := ctx.ChatMember.NewChatMember.GetUser()
	text := fmt.Sprintf("%s先生好走！", getUserFullName(&leftUser))
	_, err := b.SendMessage(ctx.ChatMember.Chat.Id, text, nil)
	return err
}
func showBannedMessageToChat(b *gotgbot.Bot, ctx *ext.Context) error {
	bannedUser := ctx.ChatMember.NewChatMember.GetUser()
	text := fmt.Sprintf("%s被管理的大手处理，彻底离开了我们", getUserFullName(&bannedUser))
	_, err := b.SendMessage(ctx.ChatMember.Chat.Id, text, nil)
	return err
}

type newGroupUserKey struct {
	UserId int64
	ChatId int64
}
type newGroupUser struct {
	until   time.Time
	fn      *time.Timer
	sentMsg *gotgbot.Message
}

var newGroupUsers = xsync.NewMap[newGroupUserKey, *newGroupUser]()

func showWelcomeMessageToUserJoinedByLink(b *gotgbot.Bot, ctx *ext.Context) error {
	user := ctx.ChatMember.NewChatMember.GetUser()
	key := newGroupUserKey{UserId: user.Id, ChatId: ctx.ChatMember.Chat.Id}
	until := time.Now().Add(10 * time.Minute)
	value := &newGroupUser{fn: time.AfterFunc(time.Until(until), func() {
		_, err := b.BanChatMember(key.ChatId, key.UserId, nil)
		if err != nil {
			log.Println(err)
		}
	})}
	newGroupUsers.Store(key, value)
	text := fmt.Sprintf("欢迎<a href=\"%s\">%s</a>先生加入本群，和大家随便说点什么证明您是人类吧，否则bot还是会在10分钟后(%s)请您出去。",
		fmt.Sprintf("tg://user?id=%d", key.UserId),
		html.EscapeString(getUserFullName(&user)), until.Format(time.DateTime))
	msg, err := b.SendMessage(ctx.ChatMember.Chat.Id, text, &gotgbot.SendMessageOpts{
		ParseMode: gotgbot.ParseModeHTML,
	})
	value.sentMsg = msg
	return err
}

func handleAnyNewMsg(b *gotgbot.Bot, ctx *ext.Context) error {
	if ctx.EffectiveMessage.From == nil || len(ctx.EffectiveMessage.NewChatMembers) != 0 {
		return nil
	}
	userId := ctx.EffectiveMessage.From.Id
	chatId := ctx.EffectiveMessage.Chat.Id
	key := newGroupUserKey{UserId: userId, ChatId: chatId}
	ngu, ok := newGroupUsers.Load(key)
	if !ok {
		return nil
	}
	defer newGroupUsers.Delete(key)
	ngu.fn.Stop()
	text := fmt.Sprintf("欢迎<a href=\"%s\">%s</a>先生加入本群！",
		fmt.Sprintf("tg://user?id=%d", userId),
		html.EscapeString(getUserFullName(ctx.EffectiveMessage.From)))
	if ngu.sentMsg == nil {
		return nil
	}
	_, _, err := ngu.sentMsg.EditText(b, text, &gotgbot.EditMessageTextOpts{ParseMode: gotgbot.ParseModeHTML})
	if err != nil {
		log.Println(err)
	}

	return nil
}
