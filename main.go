package main

import (
	"fmt"
	"github.com/caarlos0/env/v11"
	"github.com/puzpuzpuz/xsync/v4"
	"html"
	"log"
	"net/http"
	"reflect"
	"time"

	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/PaulSonOfLars/gotgbot/v2/ext"
	"github.com/PaulSonOfLars/gotgbot/v2/ext/handlers"
)

type config struct {
	BotToken string `env:"BOT_TOKEN" envDefault:"" help:"Telegram Bot Token, 必选" secret:"true"`
	Testing  bool   `env:"TESTING" envDefault:"false" help:"测试用开关，打开后即使在浏览器打开也可以视同Telegram小程序"`
	ApiAddr  string `env:"API_ADDR" envDefault:"https://api.telegram.org"`

	DatabasePath string `env:"DATABASE_PATH" envDefault:"./data.sqlite" help:"SQLite 存储文件路径"`

	ListenAddress string `env:"LISTEN_ADDR" envDefault:":8532" help:"监听地址"`
	TlsCertPath   string `env:"TLS_CERT" envDefault:"" help:"TLS 证书文件，同时设置证书与密钥可启用TLS监听"`
	TlsKeyPath    string `env:"TLS_KEY" envDefault:"" help:"TLS 密钥文件"`

	// 公开，请求时会发送给客户端
	TurnstileSiteKey string `env:"TURNSTILE_SITE_KEY" envDefault:"" help:"Turnstile网站key，公开，需要发送给用户用于识别。"`
	// 私有，只会存在服务器端
	TurnstileSecret string `env:"TURNSTILE_SECRET" envDefault:"" help:"Turnstile密钥，私有，只会保存在后端程序中" secret:"true"`
}

var cfg config
var persistentStore *PersistentStore

func hideSecret(secret string) string {
	if len(secret) < 12 {
		return "*****"
	}
	runes := []rune(secret)
	n := len(runes)
	return fmt.Sprintf("%s*****%s", string(runes[:4]), string(runes[n-4:]))
}
func printConfigHelp(cfg interface{}) {
	cfgType := reflect.TypeOf(cfg)
	cfgValue := reflect.ValueOf(cfg)
	for i := 0; i < cfgType.NumField(); i++ {
		field := cfgType.Field(i)
		value := cfgValue.Field(i)

		envTag := field.Tag.Get("env")
		help := field.Tag.Get("help")
		isSecret := field.Tag.Get("secret") == "true"

		raw := fmt.Sprintf("%v", value.Interface())
		display := ""

		if isSecret {
			display = hideSecret(raw)
		} else if raw == "" {
			// 使用 ANSI 转义序列上色，灰色或红色
			display = "\033[1;31m<empty>\033[0m"
		} else {
			display = raw
		}

		fmt.Printf("%-20s = %-30s  # %s\n", envTag, display, help)
	}
}

func init() {
	err := env.Parse(&cfg)
	if err != nil {
		log.Fatal(err)
	}
	persistentStore, err = NewPersistentStore(cfg.DatabasePath)
	if err != nil {
		log.Fatalf("init persistent store failed: %v", err)
	}
	if cfg.TurnstileSiteKey == "" || cfg.TurnstileSecret == "" {
		log.Printf("\033[1;43;30mTurnstileKey未配置，使用测试Key，请务必在生产环境中配置正确的环境变量，当前 siteKey=%s, secret=%s\033[0m",
			cfg.TurnstileSiteKey, cfg.TurnstileSecret)
		cfg.TurnstileSiteKey = "1x00000000000000000000AA"
		cfg.TurnstileSecret = "1x0000000000000000000000000000000AA"
	}
	printConfigHelp(cfg)
}

// This bot is as basic as it gets - it simply repeats everything you say.
// The main_test.go file contains example code to demonstrate how to implement the gotgbot.BotClient interface for it to be used in tests.
func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	// Get token from the environment variable
	go initHttp()
	// Create bot from environment value.
	b, err := gotgbot.NewBot(cfg.BotToken, &gotgbot.BotOpts{
		BotClient: &gotgbot.BaseBotClient{
			Client: http.Client{},
			DefaultRequestOpts: &gotgbot.RequestOpts{
				Timeout: 10 * time.Second, // Customise the default request timeout here
				APIURL:  cfg.ApiAddr,      // As well as the Default API URL here (in case of using local bot API servers)
			},
		},
	})
	if err != nil {
		panic("failed to create new bot: " + err.Error())
	}
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

	dispatcher.AddHandler(handlers.NewChatMember(isUserInvitedByOtherMember, showWelcomeMessageToUserViaInvited))
	dispatcher.AddHandler(handlers.NewChatMember(isBotInvitedByOtherMember, showWelcomeMessageToBotViaInvited))
	dispatcher.AddHandler(handlers.NewChatMember(isUserLeft, showGoodbyeMessageToChat))
	dispatcher.AddHandler(handlers.NewChatMember(isUserBanned, showBannedMessageToChat))
	dispatcher.AddHandler(handlers.NewChatMember(isUserJoinedByLink, showWelcomeMessageToUserJoinedByLink))
	dispatcher.AddHandler(handlers.NewMessage(isGroupMessage, handleAnyNewMsg))
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
	_, ok1 := u.OldChatMember.(gotgbot.ChatMemberLeft)
	_, ok2 := u.OldChatMember.(gotgbot.ChatMemberBanned)
	if !ok1 && !ok2 {
		return false
	}
	mm, ok := u.NewChatMember.(gotgbot.ChatMemberMember)
	// 原来是不在群组中的人，且消息动作来自其他人，且没有邀请链接，就说明是从其他用户邀请来的
	return ok && u.From.Id != mm.User.Id && u.InviteLink == nil
}

func isBotInvitedByOtherMember(u *gotgbot.ChatMemberUpdated) bool {
	return isInvitedByOtherMember(u) && u.NewChatMember.GetUser().IsBot
}

func isUserInvitedByOtherMember(u *gotgbot.ChatMemberUpdated) bool {
	return isInvitedByOtherMember(u) && !u.NewChatMember.GetUser().IsBot
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

func showWelcomeMessageToUserViaInvited(b *gotgbot.Bot, ctx *ext.Context) error {
	inviter := ctx.ChatMember.From
	invitee := ctx.ChatMember.NewChatMember.GetUser()
	text := fmt.Sprintf(`原来是%s先生请来的贵客，%s先生您也请。`, getUserFullName(&inviter), getUserFullName(&invitee))
	_, err := b.SendMessage(ctx.ChatMember.Chat.Id, text, nil)
	return err
}

func showWelcomeMessageToBotViaInvited(b *gotgbot.Bot, ctx *ext.Context) error {
	inviter := ctx.ChatMember.From
	invitee := ctx.ChatMember.NewChatMember.GetUser()
	text := fmt.Sprintf(`原来是%s先生请来的打工bot %s，这里打工007的！`, getUserFullName(&inviter), getUserFullName(&invitee))
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
	untilDate := ctx.ChatMember.NewChatMember.(gotgbot.ChatMemberBanned).UntilDate
	log.Printf("untilDate = %d", untilDate)
	var text string
	until := time.Unix(untilDate, 0)
	now := time.Now()
	subTime := until.Sub(now)
	subTime -= 10 * time.Second // 用于避免配置整单位时间时，传到bot时与telegram服务器的时间差
	if untilDate == 0 {
		text = fmt.Sprintf("%s被管理的大手处理，永远离开了我们", getUserFullName(&bannedUser))
	} else if subTime < 900*time.Second {
		text = fmt.Sprintf("%s被管理的大手处理，暂时离开了我们", getUserFullName(&bannedUser))
	} else if subTime < 16*time.Hour {
		text = fmt.Sprintf("%s被管理的大手处理，离开了我们几个小时", getUserFullName(&bannedUser))
	} else if subTime < 48*time.Hour {
		text = fmt.Sprintf("%s被管理的大手处理，离开了我们一两天", getUserFullName(&bannedUser))
	} else if subTime < 7*24*time.Hour {
		text = fmt.Sprintf("%s被管理的大手处理，要离开我们好几天", getUserFullName(&bannedUser))
	} else if subTime < 30*24*time.Hour {
		text = fmt.Sprintf("%s被管理的大手处理，一个月内怕是见不到了", getUserFullName(&bannedUser))
	} else if subTime < 365*24*time.Hour {
		text = fmt.Sprintf("%s被管理的大手处理，几个月都回不来，真是判得重了", getUserFullName(&bannedUser))
	} else {
		text = fmt.Sprintf("%s被管理的大手处理，恐怕要等明年、后年，甚至下辈子才见得到了", getUserFullName(&bannedUser))
	}

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
	if !ctx.ChatMember.InviteLink.CreatesJoinRequest {
		// 用户没有使用经过管理员同意的链接加入
		_, err := b.RestrictChatMember(key.ChatId, key.UserId, gotgbot.ChatPermissions{}, nil)
		if err != nil {
			return err
		}
		verificationTimeout := defaultVerificationTimeout
		if persistentStore != nil {
			if cfg, err := persistentStore.GetOrCreateGroupConfig(key.ChatId); err == nil {
				verificationTimeout = cfg.VerificationTimeout()
			} else {
				log.Printf("加载群组配置失败: %v", err)
			}
		}
		event, loaded := userStatus.LoadOrCompute(key.UserId, func() (*UserJoinEvent, bool) {
			e := &UserJoinEvent{}
			e.Init(key.UserId, user.Username, verificationTimeout)
			return e, false
		})
		if loaded {
			event.UpdateUsername(user.Username)
			persistUserVerification(key.UserId, user.Username, event.CurrentState)
		}
		if err := recordPendingGroup(key.UserId, key.ChatId); err != nil {
			log.Printf("记录待加入群组失败: %v", err)
		}
		text := fmt.Sprintf("点击下方链接验证您是人类\nhttps://t.me/%s?startapp", b.Username)
		log.Printf("向用户%d发送人类验证消息", key.ChatId)
		_, err = b.SendMessage(key.ChatId, text, nil)
		if err != nil {
			return err
		}
		state := event.WaitForStateEvent()
		switch state {
		case userVerifyFailed:
			_, err = b.BanChatMember(key.ChatId, key.UserId, nil)
			return err
		case userVerifying:
			return nil
		case userVerifySucceed:
			_, err = b.RestrictChatMember(key.ChatId, key.UserId, gotgbot.ChatPermissions{
				CanSendMessages:       true,
				CanSendAudios:         true,
				CanSendDocuments:      true,
				CanSendPhotos:         true,
				CanSendVideos:         true,
				CanSendVideoNotes:     true,
				CanSendVoiceNotes:     true,
				CanSendPolls:          true,
				CanSendOtherMessages:  true,
				CanAddWebPagePreviews: true,
				CanChangeInfo:         true,
				CanInviteUsers:        true,
				CanPinMessages:        true,
				CanManageTopics:       true,
			}, nil)
		}
		if err != nil {
			return err
		}
	}
	until := time.Now().Add(10 * time.Minute)
	value := &newGroupUser{fn: time.AfterFunc(time.Until(until), func() {
		_, err := b.BanChatMember(key.ChatId, key.UserId, nil)
		if err != nil {
			log.Println(err)
		}
	})}
	newGroupUsers.Store(key, value)
	time.Sleep(1 * time.Second)
	text := fmt.Sprintf("欢迎<a href=\"%s\">%s</a>先生加入本群，和大家随便说点什么证明您是人类吧，否则bot还是会在10分钟后(%s)请您出去。",
		fmt.Sprintf("tg://user?id=%d", key.UserId),
		html.EscapeString(getUserFullName(&user)), until.Format(time.DateTime))
	msg, err := b.SendMessage(ctx.ChatMember.Chat.Id, text, &gotgbot.SendMessageOpts{
		ParseMode: gotgbot.ParseModeHTML,
	})
	value.sentMsg = msg
	return err
}

func isGroupMessage(msg *gotgbot.Message) bool {
	return msg.Chat.Type == "supergroup" || msg.Chat.Type == "group"
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
