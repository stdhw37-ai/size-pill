# Official sign-in assets

Downloaded from provider-owned sources on 2026-09-16. These PNGs are unchanged originals, not redrawn logos. `ui.css` displays the symbol area of the official Kakao and Naver images without changing the symbol's proportions or colors.

| File | Official source |
| --- | --- |
| `google-g.png` | https://developers.google.com/static/identity/images/g-logo.png |
| `kakao-login.png` | https://developers.kakao.com/tool/resource/static/img/button/login/full/ko/kakao_login_medium_narrow.png |
| `naver-icon.png` | `NAVER_login_KR/NAVER_login_Light_KR_green_icon_H56.png` from https://developers.naver.com/inc/devcenter/downloads/bi/NAVER_login_KR.zip |
| `google-sans.ttf` | Google Fonts CSS https://fonts.googleapis.com/css2?family=Google+Sans:wght@500 → https://fonts.gstatic.com/s/googlesans/v70/4Ua_rENHsxJlGDuGo1OIlJfC6l_24rlCK1Yo_Iqcsih3SAyH6cAwhX9RFD48TE63OOYKtrw2IKli.ttf |

Guidelines reviewed:
- Google: https://developers.google.com/identity/branding-guidelines
- Kakao: https://developers.kakao.com/docs/ko/kakaologin/design-guide
- Naver: https://developers.naver.com/docs/login/bi/bi.md

The requested localized “계속하기” labels are used. Kakao's guide gives “카카오 로그인” as its standard label; this custom label has not received a separate provider review. Button colors, official symbols, proportions and overall prominence are retained. Disabled providers keep full brand colors, with separate status text rather than reduced opacity. No third-party asset CDN is contacted at runtime.
