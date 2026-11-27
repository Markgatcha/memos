# LongMemEval-S Track B matched desktop timing

## Full 500-question matched rerun

The submitted round scored 328/500 (65.6%). The matched desktop rerun scored 333/500 (66.6%). Comparing the same IDs, 27 changed to correct and 22 to incorrect. Both rounds recorded both timers and a verdict for every question. All 500 reader user-payload hashes matched.

Median per-question reader-plus-judge latency changed from 7,006.5 to 7,329.5 ms (+323 ms, +4.61%). The preregistered relative tolerance was 10%. The complete run from generation start to final verification took 81 min 34.684 s originally and 93 min 14.682 s on replay (+14.30%), including time between phases and retries. The matched result is a verification round. The original submission retains its score and time.

[Recorded summary](summary.json) · [Per-question results](per-question.jsonl) · [Preregistered comparison criteria](protocol.json)

## Audit the two recorded rounds

Run with Python 3.12 from the **end-to-end** Track B artifact directory.

```powershell
$m = 'verification/matched-desktop-20261127'
python "$m/compare.py" per-question.jsonl "$m/per-question.jsonl"
```

The original file SHA-256 is **0774e4566ea965888204aa99b70ea3981e80fe8d97bfa8127bab95e2161df024**. The published original observations yield 328/500 correct (65.6%) and a combined p50 of 7,006.5 ms from 500 measured reader–judge pairs. Each observation set is one round, so its sample standard deviation is undefined.

The script reports the input digests, all-question and paired counts, stage medians, combined p50, accuracy and differences.

- Accuracy is the number of **yes** verdicts divided by all questions in the reported cohort. **No** and unresolved each earn zero. Unresolved counts are shown separately.
- Combined p50 is the median of the per-question reader time plus judge time. A row needs both recorded times to enter this median. Missing times remain null. Accuracy and timing denominators are reported separately.
- Paired results join on organizer question ID and verify ordinal, task and abstention metadata. The JSON includes matched IDs with both times, matched IDs with both times and judgments, and the set with an equal reader prompt digest.
- Differences are rerun minus original. Relative differences use the original value as the divisor. Interpret a timing tolerance over the full set only when **all_questions_have_paired_timings** is true. A median over fewer than 500 timings describes its measured subset.

The audit runs from a public checkout without account access. It recomputes accuracy from the recorded **yes**, **no**, and unresolved outcomes and recalculates the latency summaries. Judge decisions are taken directly from the published rows. The public SDK adapter from PR #100 separately supports prompt reconstruction and account-backed regeneration at the SDK adapter boundary. The matched round was collected by the original frozen desktop runner. The optional launcher below uses the same Next components and timing windows.

## Regenerate through the matched desktop host

The host replay requires the three byte-identical frozen product trees and a dedicated DeepSeek account with both model IDs. Arrange access to the frozen trees with the product owner. This artifact contains the replay entry point and the expected SHA-256 values.

| Input | Frozen tree SHA-256 |
| --- | --- |
| Ingestion product that prepared the original per-question SQLite templates | **0f62525c261e079d599050156f485b4371f83287fd650e77611b53221f59c2d6** |
| Next desktop reader product | **d4bf1671bfc2a0eba4b897e2821669af93e1c2fb1a884a7a3bdd42ba1fab6417** |
| Next runtime used for judging | **eee9552ce02f98f7db2483dcc81d7f68e71255d571fb90f6e8100c34a9e8329e** |

Each directory contains a **desktop** subdirectory and the other frozen components. The preflight computes the SHA-256 of the UTF-8 JSON file manifest sorted by slash-delimited relative path. Each entry contains the file's **path**, **bytes**, and **sha256**. Extract the trees with byte-preserving tooling and pass their root directories. The replay uses the actual Next modules for ingestion, hosting, account authorization and SDK behavior.

Use Windows x64, Node.js 24.19.0, Python 3.12 and the official DeepSeek Harness desktop 0.2.2-rc.3 installation. The preflight verifies the installed executable and application archive. Python must be on PATH, or set **PYTHON** to the Python 3.12 executable. [Official Harness release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)

```powershell
$m = 'verification/matched-desktop-20261127'
$dataset = 'D:\Benchmark\longmemeval_s'
$ingestion = 'D:\Benchmark\Products\ingestion'
$reader = 'D:\Benchmark\Products\reader'
$judge = 'D:\Benchmark\Products\judge'
$install = 'D:\Apps\DeepSeek Harness'
$profile = 'D:\Benchmark\dedicated-account'
$output = 'D:\Benchmark\matched-run-private'

curl.exe --fail --location 'https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/2ec2a557f339b6c0369619b1ed5793734cc87533/longmemeval_s' --output $dataset
$inputs = @('--dataset', $dataset, '--ingestion', $ingestion, '--reader', $reader,
            '--judge', $judge, '--install', $install)
node "$m/host-replay.mjs" preflight @inputs
node "$m/host-replay.mjs" prepare @inputs --limit 1 --output 'D:\Benchmark\ingestion-check-private'
```

The preflight and optional ingestion check make zero model calls. Both read the required helper files, load the prompt bundle and verify the reader and judge template pins before reporting success. The ingestion check rebuilds a local SQLite template from the organizer's histories using the frozen ingestion product. The first regenerated template matched the corresponding recorded template byte for byte. The full launcher pins a private dataset snapshot, validates it before and after each projection, and verifies the prepared inputs and SQLite templates before use.

For a new account profile, start the frozen reader product's authorization-only host with the following command.

```powershell
node "$reader/desktop/host.mjs" --state $profile --dsh-installation $install --allow-authorization --port 0
```

Open the loopback origin printed by the host and select **连接 DeepSeek Harness**. Use the provider's authorization flow for the dedicated account. After the host confirms credentials were saved, stop the authorization host. The replay uses **$profile/dsh**. Keep that directory and the run output private. The Harness includes an absolute empty working-directory path in model context, so use a neutral benchmark path.

Start the actual run with the following command. It submits up to 500 reader requests and 500 judge requests to the account route. Provider responses and timing can vary across accounts, hosts, and dates.

```powershell
node "$m/host-replay.mjs" run @inputs --account "$profile/dsh" --output $output --allow-model-calls
```

**run** publishes a new output directory only after its recipe and folders are ready. If initialization is interrupted before the output appears, repeat **run** with the same output path. Use **resume** with the same inputs, limit, output and profile to continue an interrupted run. Resume with the checkout that started the run. The recipe binds the launcher, projection and rubric helpers to their SHA-256 digests. The live run loads the hashed helper bytes from a private snapshot, including the Python scripts invoked after generation. A checkout change between phases cannot replace those scripts. The runner keeps terminal rows. Under the exclusive output lock it publishes judge receipts and the final JSONL by flushing a temporary file in the same directory and renaming it. An existing completed export must match the sealed receipts byte for byte. An interruption after the dispatch marker with no final result remains unresolved and receives no second model call. For a one-question live check, add **--limit 1** and use a separate output. After the full round, the packaged launcher was also tested from a separate checkout using one live reader request and one live judge request. Both completed (6,772 ms and 1,321 ms) and the judge returned yes. The smoke check is excluded from the 500-question results.

## Timing windows

- **Reader.** The clock starts immediately before creating the Next loopback host and its account provider. It includes the owner-cookie handshake, provider catalog lookup, desktop session creation, durable intent write, chat submission, the SSE stream through completion, and parsing the product audit result. It stops at the receipt's elapsed-time sample, before receipt storage, desktop history readback and host/provider shutdown. Dataset projection, SQLite ingestion, execution-profile binding and the database copy precede the clock.
- **Judge.** The clock starts after the frozen account runtime opens. It includes the model catalog lookup, SDK initialization, durable attempt write, prompt acceptance, wait, confirmed SDK shutdown and exact verdict normalization. It stops at the receipt's elapsed-time sample. The upstream rubric is rendered before this clock. Both clocks use rounded monotonic milliseconds.
- The runner completes and seals all reader results before loading the reference-answer projection. Each stage uses concurrency one. Each question uses an isolated query host and a fresh SDK session. The median uses the sum of the two elapsed times per question and excludes idle time between phases.

## Release contents

Keep this file, **compare.py**, **host-replay.mjs**, **host-project.py** and the matched **per-question.jsonl** under **end-to-end/verification/matched-desktop-20261127**. The host replay imports the existing PR #100 **prepare.mjs** from **end-to-end**, along with its existing dependency files and licenses.

For any new replay, the private output contains the dataset snapshot, SQLite templates, host state and generation and judge receipts. The output file intended for public review is **per-question.jsonl**, which carries organizer IDs, verdicts, timings, hashes, and counters. This launcher records **reader_prompt_utf16** as null because it omits the separate SDK transcript audit. Review the output fields and values before sharing.
