package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"log"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

func hErr(str string) gin.H {
	return gin.H{"error": str, "success": false}
}

var botVerifyKey = sync.OnceValue(func() []byte {
	mac := hmac.New(sha256.New, []byte("WebAppData"))
	mac.Write([]byte(botToken))
	return mac.Sum(nil)
})
var turnstileSecretKey = os.Getenv("TURNSTILE_SECRET")
var siteKey = os.Getenv("SITE_KEY")
var testing = os.Getenv("DIO_TESTING") != ""

//go:embed index.html
var mainHtml []byte

type WebInitUser struct {
	Id              int64  `json:"id"`
	FirstName       string `json:"first_name"`
	LastName        string `json:"last_name"`
	Username        string `json:"username"`
	LanguageCode    string `json:"language_code"`
	IsPremium       bool   `json:"is_premium"`
	AllowsWriteToPm bool   `json:"allows_write_to_pm"`
}

type AuthInfo struct {
	QueryId  string      `json:"query_id"`
	User     WebInitUser `json:"user"`
	AuthDate time.Time   `json:"auth_date"`
	Hash     string      `json:"hash"`
}

func checkTelegramAuth(str string, verifyKey []byte) (res AuthInfo, err error) {
	split := strings.Split(str, "&")
	const hashPrefix = "hash"
	recvHash := ""
	data := make([]string, 0, len(split))
	for _, v := range split {
		key, value, _ := strings.Cut(v, "=")
		if key == hashPrefix {
			recvHash = value
			continue
		}
		key, err1 := url.QueryUnescape(key)
		value, err2 := url.QueryUnescape(value)
		if err1 != nil || err2 != nil {
			err = fmt.Errorf("url unescape err %v %v", err1, err2)
			return
		}
		data = append(data, key+"="+value)
	}
	if recvHash == "" {
		err = fmt.Errorf("no hash")
		return
	}

	slices.Sort(data)
	initData := []byte(strings.Join(data, "\n"))
	mac := hmac.New(sha256.New, verifyKey)
	mac.Write(initData)
	calcHash := hex.EncodeToString(mac.Sum(nil))
	if recvHash != calcHash {
		log.Printf("[checkTelegramAuth] 校验失败: calc=%s..., recv=%s...", calcHash[:6], recvHash[:6])
		err = fmt.Errorf("wrong recvHash calc=%s*** recv=%s", calcHash[:4], recvHash)
		return
	}
	for _, v := range data {
		key, value, _ := strings.Cut(v, "=")
		switch key {
		case "auth_date":
			parseInt, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return AuthInfo{}, err
			}
			res.AuthDate = time.Unix(parseInt, 0)
		case "hash":
			res.Hash = value
		case "query_id":
			res.QueryId = value
		case "user":
			var user WebInitUser
			err = json.Unmarshal([]byte(value), &user)
			if err != nil {
				return
			}
			res.User = user
		}
	}
	return
}
func verifyHeader(ctx *gin.Context) {
	if testing {
		log.Println("[verifyHeader] 测试模式，跳过验证")
		auth := AuthInfo{
			QueryId: "test_query",
			User: WebInitUser{
				Id:              -12345,
				FirstName:       "Test First Name",
				LastName:        "Test Last Name",
				Username:        "Username",
				LanguageCode:    "en",
				IsPremium:       true,
				AllowsWriteToPm: true,
			},
			AuthDate: time.Now(),
			Hash:     "0xdeadbeef",
		}
		ctx.Set("auth", auth)
		userStatus.Store(int64(-12345), &UserJoinEvent{UserId: -12345})
		ctx.Next()
		return
	}
	authHeader := ctx.GetHeader("Authorization")
	log.Printf("[verifyHeader] Authorization Header: %s", authHeader)
	if authHeader == "" {
		log.Println("[verifyHeader] 缺少 Authorization Header")
		ctx.AbortWithStatusJSON(401, hErr("请确定您在Telegram中打开本页面，而不是在独立浏览器中"))
		return
	}

	const TelegramPrefix = "Telegram "
	if !strings.HasPrefix(authHeader, TelegramPrefix) {
		log.Println("[verifyHeader] Authorization Header 无效前缀")
		ctx.AbortWithStatusJSON(401, hErr("请确定您在Telegram中打开本页面，而不是在独立浏览器中，或者可能出现问题，请联系开发者"))
		return
	}

	data := authHeader[len(TelegramPrefix):]
	auth, err := checkTelegramAuth(data, botVerifyKey())
	if err != nil {
		log.Printf("[verifyHeader] Telegram 验证失败: %v", err)
		ctx.AbortWithStatusJSON(401, hErr("验证用于身份失败"+err.Error()))
		return
	}
	if time.Since(auth.AuthDate) > 5*time.Minute {
		log.Printf("[verifyHeader] 数据过期: %s", auth.AuthDate)
		ctx.AbortWithStatusJSON(401, hErr("数据过期，该网页验证时长已超过5分钟，需要重新打开网页验证"))
		return
	}
	log.Printf("[verifyHeader] 通过用户验证: %d", auth.User.Id)
	ctx.Set("auth", auth)
	ctx.Next()
}

type TurnstileToken struct {
	Token string `json:"token"`
}
type TurnstileResp struct {
	Success     bool      `json:"success"`
	ChallengeTs time.Time `json:"challenge_ts,omitempty"`
	Hostname    string    `json:"hostname,omitempty"`
	ErrorCodes  []string  `json:"error-codes,omitempty"`
	Action      string    `json:"action,omitempty"`
	Cdata       string    `json:"cdata,omitempty"`
	Metadata    struct {
		EphemeralID string `json:"ephemeral_id,omitempty"`
	} `json:"metadata,omitempty"`
}

func verifyTurnstile(ctx *gin.Context) {
	log.Println("[verifyTurnstile] 开始人类验证")
	const cfSiteVerify = `https://challenges.cloudflare.com/turnstile/v0/siteverify`
	cfIp := ctx.GetHeader("CF-Connecting-IP")
	log.Printf("[verifyTurnstile] CF-Connecting-IP: %s", cfIp)

	var token TurnstileToken
	if err := ctx.ShouldBindBodyWithJSON(&token); err != nil {
		log.Println("[verifyTurnstile] 缺少 Turnstile token")
		ctx.AbortWithStatusJSON(401, hErr("没有token"))
		return
	}
	log.Printf("[verifyTurnstile] 接收到 token: %s", token.Token)

	form := make(url.Values)
	form.Set("secret", turnstileSecretKey)
	form.Set("response", token.Token)
	if cfIp != "" {
		form.Set("remoteip", cfIp)
	}
	resp, err := http.PostForm(cfSiteVerify, form)
	if err != nil {
		log.Printf("[verifyTurnstile] 访问 Cloudflare 验证接口失败: %v", err)
		ctx.AbortWithStatusJSON(401, hErr("访问cloudflare失败，这应该不是您的问题"))
		return
	}
	defer resp.Body.Close()

	auth := ctx.MustGet("auth").(AuthInfo)
	event, ok := userStatus.LoadOrStore(auth.User.Id, &UserJoinEvent{
		mu:           sync.Mutex{},
		deleteTimer:  nil,
		UserId:       0,
		ReqTime:      time.Time{},
		CurrentState: userVerifying,
	})
	if !ok {
		log.Printf("[verifyTurnstile] 用户未加载，但bot强行开始验证: %d", event.UserId)
		event.Init(auth.User.Id)
	}
	var data TurnstileResp
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		log.Printf("[verifyTurnstile] JSON 解码失败: %v", err)
		ctx.AbortWithStatusJSON(401, hErr("解码cloudflare响应失败，这应该不是您的问题"))
		return
	}

	if !data.Success {
		log.Printf("[verifyTurnstile] Turnstile 验证失败: %v", data.ErrorCodes)
		event.SetState(userVerifyFailed)
		ctx.AbortWithStatusJSON(401, hErr("人类验证失败！"))
		return
	}

	log.Printf("[verifyTurnstile] 用户 %d 人类验证通过", auth.User.Id)
	ctx.JSON(http.StatusOK, gin.H{"success": true, "data": "人类验证成功！"})
	event.SetState(userVerifySucceed)
}

func mainPage(ctx *gin.Context) {
	ctx.Data(200, "text/html; charset=utf-8", mainHtml)
}

func initHttp() {
	if turnstileSecretKey == "" {
		turnstileSecretKey = "1x0000000000000000000000000000000AA"
	}
	if siteKey == "" {
		siteKey = "1x00000000000000000000AA"
	}
	mainHtml = bytes.ReplaceAll(mainHtml, []byte("DIO_VERIFY_URL"), []byte("verify"))
	mainHtml = bytes.ReplaceAll(mainHtml, []byte("1x00000000000000000000AA"), []byte(siteKey))

	r := gin.Default()
	r.GET("/", mainPage)
	r.POST("/verify", verifyHeader, verifyTurnstile)
	addr := os.Getenv("DIO_LISTEN_ADDR")
	if addr == "" {
		addr = ":8532"
	}
	tlsCert := os.Getenv("DIO_TLS_CERT")
	tlsKey := os.Getenv("DIO_TLS_KEY")
	if tlsCert != "" || tlsKey != "" {
		if tlsCert != "" && tlsKey != "" {
			err := r.RunTLS(addr, tlsCert, tlsKey)
			if err != nil {
				panic(err)
			}
			return
		}
		panic(fmt.Errorf("run TLS error, TLS_CERT=%s TLS_KEY=%s", tlsCert, tlsKey))
		return
	}
	fmt.Println("You can use DIO_TLS_CERT and DIO_TLS_KEY env var to serve https")
	err := r.Run(addr)
	if err != nil {
		panic(err)
	}
}
