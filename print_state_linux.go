//go:build linux

package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func init() {
	c := make(chan os.Signal)
	signal.Notify(c, syscall.SIGUSR1)
	go func() {
		for _ = range c {
			fmt.Println("当前用户状态")
			userStatus.Range(func(_ int64, v *UserJoinEvent) bool {
				fmt.Printf("  %s", v.String())
				return true
			})
		}
	}()
}
