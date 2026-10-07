# BoxChecker

BoxChecker listens to a spoken conversation and fact-checks the claims made in it as the conversation unfolds.

## Language

### The conversation

**Conversation**:
A single recorded or live exchange between one or more Speakers, from start to end.
_Avoid_: Session, call, chat

**Speaker**:
A participant in a Conversation whose speech is attributed to them.
_Avoid_: User, member, participant

**Utterance**:
A contiguous stretch of speech by one Speaker, with a start and end time within the Conversation.
_Avoid_: Message, segment, line

**Transcript**:
The ordered sequence of Utterances that makes up a Conversation.

**Replay**:
Processing a recorded Conversation in time order so that, at every moment, only the Transcript so far is known — as if it were live.
_Avoid_: Batch, simulation, playback

### Fact-checking

**Claim**:
A checkable assertion about the world made in one or more Utterances, restated so it can be understood without the surrounding Conversation: a fact, a statistic, a quote or attribution, or a report of a recent event. Opinions, predictions, and personal statements about the Speakers themselves are never Claims. A Claim made again later, by anyone, is the same Claim.
_Avoid_: Statement, fact, assertion

**Screening**:
The cheap first pass that finds Claims in the Transcript and decides which deserve Verification.
_Avoid_: Filtering, triage, detection

**Verification**:
The evidence-backed check of a single Claim against external Sources.
_Avoid_: Fact-check (as a noun for the process), lookup

**Verdict**:
The conclusion of a Verification: **Supported**, **Refuted**, **Misleading** (true in letter but false in implication), or **Unverifiable** (insufficient evidence), always with a confidence and its Sources.
_Avoid_: Rating, result, score

**Source**:
A piece of external evidence cited by a Verification.
_Avoid_: Reference, citation, link

**Interjection**:
A short text message BoxChecker posts into the Conversation about a Verdict. Most Verifications never produce one, and a Claim is never interjected on twice.
_Avoid_: Correction, alert, notification, reply

### Evaluation

**Planted Claim**:
A Claim deliberately made in a test recording, whose correct Verdict is written down in advance.
_Avoid_: Test claim, fixture, golden
