package main

import (
	"github.com/PaulSonOfLars/gotgbot/v2"
)

func isMemberJoinByLink(u *gotgbot.ChatMemberUpdated) bool {
	return u.InviteLink != nil || u.ViaChatFolderInviteLink
}

func isMemberInvited(u *gotgbot.ChatMemberUpdated) bool {
	if u.InviteLink != nil {
		return false
	}
	return u.NewChatMember.GetUser().Id != u.From.Id
}

func isMemberLeft(u *gotgbot.ChatMemberUpdated) bool {
	_, ok := u.NewChatMember.(*gotgbot.ChatMemberLeft)
	return ok
}
func isMemberBanned(u *gotgbot.ChatMemberUpdated) bool {
	_, ok := u.NewChatMember.(*gotgbot.ChatMemberBanned)
	return ok
}

func isMemberRestricted(u *gotgbot.ChatMemberUpdated) bool {
	_, ok := u.NewChatMember.(*gotgbot.ChatMemberRestricted)
	return ok
}
