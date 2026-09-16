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

`.devcontainer/devcontainer.json`에는 8787 자동 포워딩과
`내 약 확인하기` 라벨, `onAutoForward: silent`가 설정되어 있습니다.
포트 포워딩은 유지하되 브라우저나 미리보기 탭은 자동으로 열지 않습니다.
기존 Codespace에 남아 있는 `openBrowser` 설정도 덮어쓰도록
`.vscode/settings.json`의 `remote.portsAttributes`에 같은 8787 설정을 둡니다.
`npm run dev`는 빌드 후 Wrangler 서버만 시작하며 `--open`을 사용하지 않습니다.

개발 검증은 localhost curl 또는 headless browser를 우선합니다.
브라우저 자동화에서는 하나의 browser/page를 재사용하고 종료 시 close합니다.
사용자가 이미 연 개발 페이지는 서버 재시작 후 그 탭에서 새로고침합니다.

`silent`는 자동 포워딩 시 별도 동작을 하지 않는 유효한 값입니다:
[Dev Container 공식 스키마](https://github.com/devcontainers/spec/blob/main/schemas/devContainer.base.schema.json).

포워딩과 visibility는
[GitHub Codespaces 공식 안내](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)에
따릅니다. Public으로 변경하는 명령은 포함하지 않습니다.
