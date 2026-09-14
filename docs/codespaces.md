# Codespaces 개발서버

Codespace를 다시 열면 프로젝트 터미널에서 다음 명령 하나를 실행합니다.

```sh
npm run start:codespace
```

이 프로젝트 디렉터리에서 실행 중인 Wrangler dev/workerd serve 프로세스를
정리하고, 빌드한 뒤 `0.0.0.0:8787`에서 개발서버를 foreground로 실행합니다.
다른 프로젝트의 프로세스는 종료하지 않습니다. 다른 서비스가 8787을 사용하면
오류로 중단하며 임의의 다른 포트로 변경하지 않습니다.

Codespaces에서는 GitHub CLI로 8787의 visibility를 매번 Private로 설정합니다.
설정에 실패하면 서버를 시작하지 않으며, 오류를 터미널에 표시합니다.
일반 Codespaces 이미지에 포함된 Node.js, npm, gh, curl, flock을 사용합니다.
의존성이 없으면 `npm ci`도 자동 실행합니다.

HTTP 200 응답을 확인하면 터미널에 다음 형태의 접속 링크가 출력됩니다.

```text
https://<현재 CODESPACE_NAME>-8787.app.github.dev
```

GitHub에 로그인한 브라우저에서 `Codespaces (Private)` 링크를 클릭합니다.
서버를 사용하는 동안 터미널을 열어 두세요. `Ctrl+C`로 종료합니다.
같은 시작 명령을 다시 실행하면 기존 개발서버를 정리하고 다시 시작합니다.

`.devcontainer/devcontainer.json`에는 8787 자동 포워딩,
`size-pill dev` 라벨, `openBrowser`가 설정되어 있습니다.
이 설정은 새 컨테이너 생성 또는 컨테이너 재빌드 시 적용됩니다.
기존 컨테이너에서도 시작 스크립트가 Private 포트 설정을 수행하므로
서버 시작과 접속 링크 사용을 위해 재빌드를 먼저 할 필요는 없습니다.
브라우저 자동 열기와 라벨 적용은 VS Code의 devcontainer 설정 반영 여부에 따릅니다.

포워딩과 visibility는
[GitHub Codespaces 공식 안내](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)에
따릅니다. Public으로 변경하는 명령은 포함하지 않습니다.
