import { useState } from "react";
import { Link } from "react-router";

/**
 * 아이폰 단축어로 결제 알림 보내게 하는 법 (`/ledger/notify/setup`).
 *
 * 화면으로 만든 이유: 이 설정은 **주소와 열쇠가 사람마다 다르다.** 문서에 적어 두면 거기 적힌
 * 남의 주소를 그대로 치게 된다. 여기서는 **지금 보고 있는 사이트의 주소**를 넣어 보여주고
 * 복사까지 해 준다.
 *
 * 캡처를 쓰지 않고 글과 표로 적는다 — 설정 화면 캡처에는 열쇠 값이 같이 찍힌다.
 */
export function NotifySetupPage() {
  const origin = typeof location === "undefined" ? "" : location.origin;
  const endpoint = `${origin}/api/ledger/notify`;
  return (
    <section className="lg-page ns-page">
      <div className="lg-toolbar">
        <div className="lg-month-nav">
          <h1>폰 알림으로 결제 기록 받기</h1>
        </div>
        <p className="hb-muted nt-lead">
          <Link to="/ledger/notify">← 알림 화면으로</Link>
        </p>
      </div>

      <p className="ns-lead">
        카드사·은행 앱이 띄우는 <b>결제 알림</b>을 폰이 그대로 여기로 보내 줍니다. 그러면 엑셀을 가져오기 전에도 그날 쓴 돈이 달력에 <b>임시</b>로 올라옵니다. 나중에 엑셀이 들어오면
        임시 줄은 사라지고, <b>적어 둔 메모와 분류는 그 결제로 옮겨 붙습니다.</b>
      </p>
      <p className="ns-lead">
        <b>아이폰</b>은 기본 <b>단축어</b> 앱으로, <b>안드로이드</b>는 <b>MacroDroid·Tasker</b> 같은 자동화 앱으로 보냅니다. <b>보내는 내용은 똑같습니다</b> — 아래 3번의 주소·헤더·본문을
        그대로 쓰면 됩니다.
      </p>

      <Step n={1} title="알림 키를 먼저 넣습니다">
        <p>
          Cloudflare 대시보드 → <b>컴퓨트 → Workers 및 Pages</b> → 이 사이트 → <b>설정</b> → <b>변수 및 시크릿</b> 에서 <Code>NOTIFY_TOKEN</Code> 을 추가하고, 아무도 못 맞출 긴 값을 넣습니다(영문·숫자 30자 이상).
        </p>
        <p className="ns-warn">
          이 값은 <b>단축어 앱 안에 그대로 보입니다.</b> 그래서 엑셀을 올리는 <Code>IMPORT_TOKEN</Code> 과는 <b>반드시 다른 값</b>으로 두세요. 알림 키로는 임시 거래를 넣는 것까지만 되고,
          엑셀이 덮으면 사라집니다 — 새어도 피해가 거기서 멈추게 해 둔 것입니다.
        </p>
      </Step>

      <Step n={2} title="자동화 만들기 — 아이폰">
        <ul>
          <li>
            <b>단축어</b> 앱 → 아래 <b>자동화</b> 탭 → 오른쪽 위 <b>+</b>
          </li>
          <li>
            목록에서 <b>앱</b> 을 고르고, <b>알림을 받을 때</b> 를 켭니다 (iOS 버전에 따라 이름이 조금 다릅니다)
          </li>
          <li>
            <b>앱 선택</b> 에서 <b>내가 쓰는 카드사·은행·페이 앱</b>을 고릅니다 — 여러 개 한꺼번에 고를 수 있습니다
          </li>
          <li>
            <b>즉시 실행</b> 으로 둡니다 (물어보지 않고 바로 보내게)
          </li>
        </ul>
        <p className="ns-note">
          어떤 앱을 고를지는 <b>사람마다 다릅니다.</b> 쓰는 카드가 토스면 토스, 현대카드면 현대카드를 고르세요. 은행 앱은 입출금 알림까지 보내므로 결제 알림만 쓰고 싶으면 빼도 됩니다.
          나중에 얼마든지 더하거나 뺄 수 있습니다.
        </p>
      </Step>

      <Step n={3} title="보낼 내용 — 아이폰·안드로이드 공통">
        <p>
          아이폰은 동작 추가에서 <b>URL의 콘텐츠 가져오기</b> 를 찾아 넣고 화살표를 눌러 펼칩니다. 안드로이드는 <b>HTTP 요청</b> 동작을 넣습니다. 채울 것은 같습니다.
        </p>
        <CopyRow label="URL" value={endpoint} />
        <table className="ns-table">
          <tbody>
            <tr>
              <th>메소드</th>
              <td>
                <Code>POST</Code>
              </td>
            </tr>
            <tr>
              <th>헤더</th>
              <td>
                <Code>X-Import-Token</Code> = 1번에서 넣은 알림 키
                <br />
                <Code>Origin</Code> = <Code>{origin}</Code>
              </td>
            </tr>
            <tr>
              <th>본문 요청</th>
              <td>
                <Code>JSON</Code> 으로 바꾸고 아래 다섯 칸을 만듭니다
              </td>
            </tr>
          </tbody>
        </table>
        <table className="ns-table ns-fields">
          <thead>
            <tr>
              <th>키</th>
              <th>값 (단축어의 알림 변수에서 고릅니다)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>app</th>
              <td>알림 ▸ 앱</td>
            </tr>
            <tr>
              <th>title</th>
              <td>알림 ▸ 제목</td>
            </tr>
            <tr>
              <th>subtitle</th>
              <td>알림 ▸ 부제</td>
            </tr>
            <tr>
              <th>body</th>
              <td>알림 ▸ 본문</td>
            </tr>
            <tr>
              <th>sentAt</th>
              <td>알림 ▸ 날짜</td>
            </tr>
          </tbody>
        </table>
        <p className="ns-note">
          값 칸을 누르고 <b>변수 선택</b> 에서 고르면 됩니다. 다섯 칸을 다 못 채워도 괜찮습니다 — 보내 주는 것만으로 읽어 봅니다. 다만 <Code>sentAt</Code> 이 없으면 결제 시각이 아니라 <b>받은 시각</b>으로 기록됩니다.
        </p>
      </Step>

      <Step n={4} title="자동화 만들기 — 안드로이드">
        <p>
          안드로이드는 알림을 넘겨 줄 <b>자동화 앱</b>이 하나 필요합니다. <b>MacroDroid</b>(쉽고 무료로 충분합니다)나 <b>Tasker</b> 중 아무거나 쓰면 됩니다. 둘 다 처음에 <b>알림 읽기 권한</b>을 달라고 하는데, 그걸 줘야 알림 내용을 볼 수 있습니다.
        </p>
        <p>MacroDroid 기준으로 이렇게 만듭니다.</p>
        <ul>
          <li>
            <b>트리거</b>: 알림 → <b>알림 수신</b> → 앱으로 <b>내가 쓰는 카드사·은행·페이 앱</b>을 고릅니다
          </li>
          <li>
            <b>동작</b>: 연결 → <b>HTTP 요청</b> → 방식 <Code>POST</Code>, 내용 종류 <Code>application/json</Code>
          </li>
          <li>주소·헤더·본문은 <b>3번과 똑같이</b> 넣습니다</li>
          <li>
            본문의 값에는 그 앱이 주는 변수를 넣습니다 — MacroDroid 는 <Code>{"{not_title}"}</Code>(제목)·<Code>{"{not_text}"}</Code>(본문)·<Code>{"{not_app_name}"}</Code>(앱 이름) 처럼
            중괄호로 고릅니다. Tasker 는 <Code>%evtprm2</Code> 같은 이름입니다 (버전마다 다르니 변수 고르기 목록에서 찾으세요)
          </li>
        </ul>
        <p className="ns-note">
          보낼 수 있는 칸이 제목·본문뿐이어도 괜찮습니다. 그때는 <Code>sentAt</Code> 없이 보내게 되는데, 결제 시각 대신 <b>받은 시각</b>으로 기록될 뿐입니다.
        </p>
      </Step>

      <Step n={5} title="잘 되는지 봅니다">
        <p>
          카드를 한 번 쓰고 알림이 오면, <Link to="/ledger/notify">알림 화면</Link> 의 <b>마지막 폰 알림</b> 이 방금으로 바뀝니다. 읽어낸 결제는 달력에 <b>임시</b> 꼬리표로 올라옵니다.
        </p>
        <p className="ns-note">광고나 잔액 안내처럼 거래가 아닌 알림도 그대로 들어옵니다 — 버리지 않고 모아 둡니다. 무엇을 걸러야 하는지 알려면 그것들이 필요해서입니다.</p>
      </Step>

      <Step n={6} title="읽지 못하는 알림이 있을 때">
        <p>
          <b>앱마다 알림 문구가 다릅니다.</b> 지금 읽을 줄 아는 문구는 몇 가지뿐이라, 쓰시는 앱의 알림은 <b>원문만 쌓이고 거래로는 안 들어갈 수 있습니다.</b> 그래도 괜찮습니다 — 원문이 남아
          있으니 나중에 규칙을 더하면 그때부터 읽힙니다.
        </p>
        <p>
          알림 화면 아래 <b>받은 알림</b> 목록에서 <b>읽지 못함</b> 으로 뜬 줄을 찾아, 그 문구를 <b>클로드 같은 AI 에게 그대로 주고</b> 이렇게 부탁하면 됩니다.
        </p>
        <blockquote className="ns-quote">
          이 저장소의 <Code>apps/ledger/src/importers/notify-parse.ts</Code> 에, 아래 알림 문구를 읽어 결제로 만드는 규칙을 더해 줘. 모르는 문구는 <Code>null</Code> 로 두는 지금 방식을
          지키고, 테스트도 같이 만들어 줘.
          <br />
          <span className="ns-quote-sample">앱: ○○카드 / 제목: … / 본문: …</span>
        </blockquote>
        <p className="ns-note">
          규칙을 느슨하게 만들면 광고를 결제로 잘못 넣습니다. <b>모르면 안 넣는 쪽</b>이 빈 화면보다 낫습니다 — 그래서 지금 코드도 그렇게 돼 있습니다.
        </p>
      </Step>

      <Step n={7} title="알아 둘 것">
        <ul>
          <li>
            <b>폰이 꺼져 있거나 알림을 못 받으면 조용히 빠집니다.</b> 그래서 이것만으로는 가계부가 채워지지 않습니다 — 엑셀 가져오기가 본진이고, 알림은 그 사이를 메웁니다.
          </li>
          <li>가맹점 이름이 결제대행사로 찍히는 일이 많습니다(네이버페이 결제가 「네이버파이낸셜」 처럼). 분류를 한 번 골라 두면 같은 이름의 다음 알림부터 그대로 씁니다.</li>
          <li>같은 결제를 카드사 앱과 페이 앱이 둘 다 알릴 수 있습니다. 그러면 임시 줄이 두 개 생기는데, 엑셀이 들어오면 정리됩니다.</li>
        </ul>
      </Step>
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="ns-step">
      <h2>
        <span className="ns-num">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

const Code = ({ children }: { children: React.ReactNode }) => <code className="ns-code">{children}</code>;

/** 주소처럼 손으로 치면 틀리기 쉬운 값은 복사 단추를 붙인다 */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="ns-copy">
      <span className="ns-copy-label">{label}</span>
      <code className="ns-copy-value">{value}</code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => {
              setDone(true);
              setTimeout(() => setDone(false), 2000);
            },
            () => {},
          );
        }}
      >
        {done ? "복사됨" : "복사"}
      </button>
    </div>
  );
}
