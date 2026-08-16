import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import logging
import argparse
import os, json, sys
import random
from datetime import date, timedelta, datetime
from generative_agents.conversation_utils import *
from generative_agents.html_utils import convert_to_chat_html
from generative_agents.event_utils import *
from generative_agents.memory_utils import *
from transformers import BlipProcessor, BlipForConditionalGeneration
from PIL import Image
from global_methods import run_chatgpt, run_chatgpt_with_examples, set_openai_key

logging.basicConfig(level=logging.INFO)


def parse_args():

    parser = argparse.ArgumentParser()

    parser.add_argument('--out-dir', required=True, type=str, help="Path to directory containing agent files and downloaded images for a conversation")
    parser.add_argument('--prompt-dir', required=True, type=str, help="Path to the dirctory containing in-context examples")
    
    parser.add_argument('--start-session', type=int, default=1, help="Start iterating from this index; first session is 1")
    parser.add_argument('--num-sessions', type=int, default=20, help="Maximum number of sessions in the conversation")
    parser.add_argument('--num-days', type=int, default=240, help="Desired temporal span of the multi-session conversation")
    parser.add_argument('--num-events', type=int, default=15, help="Total number of events to generate for each agent; 1 per session works best")
    parser.add_argument('--max-turns-per-session', type=int, default=20, help="Maximum number of total turns in each session")
    parser.add_argument('--num-events-per-session', type=int, default=50, help="Total number of events to be assigned to each agent per session; 1-2 works best")

    parser.add_argument('--persona', action="store_true", help="Set flag to sample a new persona from MSC and generate details")
    parser.add_argument('--session', action="store_true", help="Set flag to generate sessions based on the generated/existing personas")
    parser.add_argument('--events', action="store_true", help="Set flag to generate and events suited to the generated/existing personas")
    parser.add_argument('--blip-caption', action="store_true", help="Set flag to use BLIP model to generate captions for downloaded images")
    parser.add_argument('--overwrite-persona', action='store_true', help="Overwrite existing persona summaries saved in the agent files")
    parser.add_argument('--overwrite-events', action='store_true', help="Overwrite existing events saved in the agent files")
    parser.add_argument('--overwrite-session', action='store_true', help="Overwrite existing sessions saved in the agent files")
    parser.add_argument('--summary', action="store_true", help="Set flag to generate and use summaries in the conversation generation prompt")

    parser.add_argument('--emb-file', type=str, default='embeddings.pkl', help="Name of the file used to save embeddings for the fine-grained retrieval-based memory module")
    parser.add_argument('--reflection', action="store_true", help="Set flag to use reflection module at the end of each session and include in the conversation generation prompt for context")

    args = parser.parse_args()
    return args


def get_blip_caption(img_file, model, processor):

    raw_image = Image.open(img_file).convert('RGB')
    # conditional image captioning
    text = "a photography of"
    inputs = processor(raw_image, text, return_tensors="pt").to("cuda")
    out = model.generate(**inputs)
    caption = processor.decode(out[0], skip_special_tokens=True)
    return caption


def save_agents(agents, args):

    agent_a, agent_b = agents
    logging.info("Saving updated Agent A to %s" % args.agent_a_file)
    with open(args.agent_a_file, 'w') as f:
        json.dump(agent_a, f, indent=2)
    logging.info("Saving updated Agent B to %s" % args.agent_b_file)
    with open(args.agent_b_file, 'w') as f:
        json.dump(agent_b, f, indent=2)


def load_agents(args):

    agent_a = json.load(open(args.agent_a_file))
    agent_b = json.load(open(args.agent_b_file))
    return agent_a, agent_b


def get_random_time():

    start_time = timedelta(hours=9, minutes=0, seconds=0)
    end_time = timedelta(hours=21, minutes=59, seconds=59)
    random_seconds = random.randint(start_time.total_seconds(), end_time.total_seconds())
    hours = random_seconds//3600
    minutes = (random_seconds - (hours*3600))//60
    return timedelta(hours=hours, minutes=minutes, seconds=0)


def datetimeStr2Obj(dateStr):
    if 'am' in dateStr:
        datetimeObj = datetime.strptime(dateStr, "%H:%M am on %d %B, %Y")
    else:
        datetimeObj = datetime.strptime(dateStr, "%H:%M pm on %d %B, %Y")
    return datetimeObj

def datetimeObj2Str(datetimeObj):

    time_mod = 'am' if datetimeObj.hour <= 12 else 'pm'
    hour = datetimeObj.hour if datetimeObj.hour <= 12 else datetimeObj.hour-12
    min = str(datetimeObj.minute).zfill(2)
    return str(hour) + ':' + min + ' ' + time_mod + ' on ' + str(datetimeObj.day) + ' ' + datetimeObj.strftime("%B") + ', ' + str(datetimeObj.year)


def dateObj2Str(dateObj):
    return dateObj.strftime("%d") + ' ' + dateObj.strftime("%B") + ', ' + dateObj.strftime("%Y")


def get_random_date():

    # initializing dates ranges
    test_date1, test_date2 = date(2022, 1, 1), date(2023, 6, 1)
    # getting days between dates
    dates_bet = test_date2 - test_date1
    total_days = dates_bet.days
    delta_days = random.choice(range(1, total_days))
    random_date = test_date1 + timedelta(days=int(delta_days))
    return random_date


def get_session_summary(session, speaker_1, speaker_2, curr_date, previous_summary=""):

    session_query = ''
    for c in session:
        session_query += "%s: %s\n" % (c["speaker"], c["text"])
        if "image" in c:
            session_query += "[%s shares %s]\n" % (c["speaker"], c["image"])

    if previous_summary:

        query = SESSION_SUMMARY_PROMPT % (speaker_1['name'], speaker_2['name'], previous_summary, curr_date,
                                               speaker_1['name'], speaker_2['name'], session_query, speaker_1['name'], speaker_2['name'])
    else:
        query = SESSION_SUMMARY_INIT_PROMPT % (speaker_1['name'], speaker_2['name'], curr_date, session_query)

    query += '\n\n'
    # should summarize persona, previous conversations with respect to speaker.
    output = run_chatgpt(query, 1, 150, 'chatgpt')
    output = output.strip()
    return output


def get_image_queries(events):

    images = [e["image"] for e in events]
    input_query = "\nInput: ".join(images)

    output = run_chatgpt(EVENT2QUERY_PROMPT % input_query, 1, 200, 'chatgpt')
    output = output.strip()
    print(output)
    json_output = clean_json_output(output)

    assert len(events) == len(json_output), [events, json_output]

    for i in range(len(events)):
        events[i]["query"] = json_output[i]
    return events


def get_all_session_summary(speaker, curr_sess_id):

    summary = "\n"
    for sess_id in range(1, curr_sess_id):
        sess_date = speaker['session_%s_date_time' % sess_id]
        sess_date = sess_date[2] + ' ' + sess_date[1] + ', ' + sess_date[0]
        summary += sess_date + ': ' + speaker["session_%s_summary" % sess_id] + '\n'
    return summary


def catch_date(date_str):
    date_format1 = '%d %B, %Y'
    date_format2 = '%d %B %Y'
    try:
        return datetime.strptime(date_str, date_format1)
    except:
        return datetime.strptime(date_str, date_format2)


def get_session_date(events, args, prev_date = None):

    agent_a_events, agent_b_events = events
    
    agent_a_events = sort_events_by_time(agent_a_events)
    curr_count = 0
    stop_count = args.num_events_per_session
    stop_date_a = None
    for e in agent_a_events:
        event_date =  catch_date(e['date'])
        if prev_date:
            if event_date >= prev_date:
                print("Including event %s for Agent A" % json.dumps(e, indent=2))
                curr_count += 1
        else:
            print("Including event %s for Agent A" % json.dumps(e, indent=2))
            curr_count += 1
        if curr_count == stop_count:
            stop_date_a = event_date
            break
    stop_date_a = event_date

    # get date from agent_b
    agent_b_events = sort_events_by_time(agent_b_events)
    curr_count = 0
    stop_date_b = None
    for e in agent_b_events:
        # event_date = datetime.strptime(e['date'], "%d %B, %Y")
        event_date = catch_date(e['date'])
        if prev_date:
            if event_date >= prev_date:
                print("Including event %s for Agent B" % json.dumps(e, indent=2))
                curr_count += 1
        else:
            print("Including event %s for Agent B" % json.dumps(e, indent=2))
            curr_count += 1
        if curr_count == stop_count:
            stop_date_b = event_date
            break
    stop_date_b = event_date

    # return max(stop_date_a, stop_date_b) + timedelta(days=1)
    return min(stop_date_a, stop_date_b) + timedelta(days=random.choice([1, 2]))


def get_relevant_events(events, curr_date, prev_date=None):

    events = sort_events_by_time(events)
    relevant_events = []
    for e in events:
        # event_date = datetime.strptime(e['date'], "%d %B, %Y")
        event_date = catch_date(e['date'])
        if event_date > curr_date:
            continue
        if prev_date:
            if event_date <= prev_date:
                continue
        relevant_events.append(e)

    return relevant_events


def get_event_string(session_events, all_events):

    id2events = {e['id']: e for e in all_events}

    event_string = ""
    for e in session_events:
        try:
            event_text = 'On' + e["date"] + ", " + e["sub-event"]
        except KeyError:
            event_text = 'On' + e["date"] + ", " + e["sub_event"]

        # if the event is caused by previous events, include them for context
        if len(e['caused_by']) > 0:
            event_text += ' Because previously'
            for e_id in e['caused_by']:
                try:
                    event_text += ', ' + id2events[e_id]["sub-event"] + ' (%s)' % id2events[e_id]["date"]
                except KeyError:
                    event_text += ', ' + id2events[e_id]["sub_event"] + ' (%s)' % id2events[e_id]["date"]
        
        event_string += event_text + "\n"

    return event_string


def remove_context(args, curr_dialog, prev_dialog, caption=None):

    prompt_data = json.load(open(os.path.join(args.prompt_dir, 'remove_context_examples.json')))
    if caption:
        query = prompt_data["input_format_w_image"].format(prev_dialog, curr_dialog, caption)
    else:
        query = prompt_data["input_format"].format(prev_dialog, curr_dialog)
    output = run_chatgpt_with_examples(prompt_data["prompt"], 
                              [[prompt_data["input_format"].format(*example["input"]) if len(example["input"]) == 2 else prompt_data["input_format_w_image"].format(*example["input"]), example["output"]] for example in prompt_data['examples']], 
                              query, num_gen=1, num_tokens_request=128, use_16k=False)
    return output


def get_agent_query(speaker_1, speaker_2, curr_sess_id=0, 
                    prev_sess_date_time='', curr_sess_date_time='', 
                    use_events=False, instruct_stop=False, dialog_id=0, last_dialog='', embeddings=None, reflection=False):

    stop_instruction = "To end the conversation, write [END] at the end of the dialog."
    if instruct_stop:
        print("**** Using stop instruction ****")

    if curr_sess_id == 1:
        
        if use_events:
            events = get_event_string(speaker_1['events_session_%s' % curr_sess_id], speaker_1['graph'])
            query = AGENT_CONV_PROMPT_SESS_1_W_EVENTS % (speaker_1['persona_summary'],
                    speaker_1['name'], speaker_2['name'], 
                    curr_sess_date_time, speaker_1['name'],  events, speaker_1['name'], speaker_2['name'], stop_instruction if instruct_stop else '')
        else:
            query = AGENT_CONV_PROMPT_SESS_1 % (speaker_1['persona_summary'],
                                speaker_1['name'], speaker_2['name'], 
                                curr_sess_date_time, speaker_1['name'],  speaker_2['name'], speaker_1['name'])
    
    else:
        if use_events:
            events = get_event_string(speaker_1['events_session_%s' % curr_sess_id], speaker_1['graph'])
            if dialog_id == 0:
                # if a new session is starting, get information about the topics discussed in last session
                context_from_1, context_from_2 = get_recent_context(speaker_1, speaker_2, curr_sess_id, reflection=reflection)
                recent_context = '\n'.join(context_from_1) + '\n' +  '\n'.join(context_from_2) # with reflection
                query = AGENT_CONV_PROMPT_W_EVENTS_V2_INIT % (speaker_1['persona_summary'],
                            speaker_1['name'], speaker_2['name'], prev_sess_date_time,
                            curr_sess_date_time, speaker_1['name'],  speaker_1['session_%s_summary' % (curr_sess_id-1)], events, stop_instruction if instruct_stop else '', speaker_2['name'])
                
            else:
                # during an ongoing session, get fine-grained information from a previous session using retriever modules
                past_context = get_relevant_context(speaker_1, speaker_2, last_dialog, embeddings, curr_sess_id, reflection=reflection)
                query = AGENT_CONV_PROMPT_W_EVENTS_V2 % (speaker_1['persona_summary'],
                            speaker_1['name'], speaker_2['name'], prev_sess_date_time,
                            curr_sess_date_time, speaker_1['name'], speaker_1['session_%s_summary' % (curr_sess_id-1)], events, past_context, stop_instruction if instruct_stop else '', speaker_2['name'])
        else:
            summary = get_all_session_summary(speaker_1, curr_sess_id)
            query = AGENT_CONV_PROMPT % (speaker_1['persona_summary'],
                                        speaker_1['name'], speaker_2['name'], prev_sess_date_time, summary,
                                        curr_sess_date_time, speaker_1['name'],  speaker_2['name'], speaker_1['name']) 
    
    return query


def get_session(agent_a, agent_b, args, prev_date_time_string='', curr_date_time_string='', curr_sess_id=0, captioner=None, img_processor=None, reflection=False):
    
    # load embeddings for retrieveing relevat observations from previous conversations
    if curr_sess_id == 1:
        embeddings = None
    else:
        embeddings = pkl.load(open(args.emb_file, 'rb'))

    # select one of the speakers to start the session at random
    curr_speaker = -1
    if random.random() < 0.5:
        conv_so_far = agent_a['name'] + ': '
        curr_speaker = 0
    else:
        conv_so_far = agent_b['name'] + ': '
        curr_speaker = 1

    session = []
    
    stop_dialog_count = args.max_turns_per_session if args.max_turns_per_session <= 10 else random.choice(list(range(10, args.max_turns_per_session))) # choose a random turn number to include instructions for ending the session
    break_at_next_a = False
    break_at_next_b = False
    for i in range(args.max_turns_per_session):

        if break_at_next_a and break_at_next_b:
            break

        if curr_speaker == 0:
            agent_query = get_agent_query(agent_a, agent_b, prev_sess_date_time=prev_date_time_string, curr_sess_date_time=curr_date_time_string,
                                    curr_sess_id=curr_sess_id, use_events=args.events, instruct_stop=i>=stop_dialog_count, 
                                    dialog_id=i, last_dialog='' if i == 0 else session[-1]['speaker'] + ' says, ' + session[-1]['clean_text'], 
                                    embeddings=embeddings, reflection=reflection)
        else:
            agent_query = get_agent_query(agent_b, agent_a, prev_sess_date_time=prev_date_time_string, curr_sess_date_time=curr_date_time_string,
                                    curr_sess_id=curr_sess_id, use_events=args.events, instruct_stop=i>=stop_dialog_count, 
                                    dialog_id=i, last_dialog='' if i == 0 else session[-1]['speaker'] + ' says, ' + session[-1]['clean_text'], 
                                    embeddings=embeddings, reflection=reflection)
        
        # if the speaker in previous turn sent an image, get caption + questions
        if len(session) > 1 and "img_id" in session[-1]:

            # caption = re.findall(r"\[.*\]", session[-1]['raw_text'])[0][1:-1]
            caption = "shares " + session[-1]['blip_caption']
            if curr_speaker == 0:
                question = run_chatgpt(VISUAL_QUESTION_PROMPT.format(agent_a['persona_summary'], 
                                                                     agent_b['persona_summary'], 
                                                                     agent_b['name'], session[-1]['clean_text'], caption,
                                                                     agent_a['name']), 1, 100, 'chatgpt')
            else:
                question = run_chatgpt(VISUAL_QUESTION_PROMPT.format(agent_a['persona_summary'], 
                                                                     agent_b['persona_summary'], 
                                                                     agent_a['name'], session[-1]['clean_text'], caption,
                                                                     agent_b['name']), 1, 100, 'chatgpt')
            question = question.strip()

            if curr_speaker == 0:
                agent_query = agent_query + f"\nUse the following question about the photo shared by {agent_b['name']} in your reply: {question}."
            else:
                agent_query = agent_query + f"\nUse the following question about the photo shared by {agent_a['name']} in your reply: {question}."

        output = run_chatgpt(agent_query + conv_so_far, 1, 100, 'chatgpt', temperature=1.2)
        output = output.strip().split('\n')[0]
        output = clean_dialog(output, agent_a['name'] if curr_speaker == 0 else agent_b['name'])
        output = {"text": output, "raw_text": output}

        image_search_query, photo_caption = insert_image_response(output["text"])
        if image_search_query is not None:
            img_dir = os.path.join(args.out_dir, 'session_%s' % curr_sess_id, 'a') if curr_speaker == 0 else os.path.join(args.out_dir, 'session_%s' % curr_sess_id, 'b')
            file_urls, file_names = get_images(image_search_query, img_dir, i)
            if file_names == []:
                print("Image not found, for search query: ", image_search_query)
            else:
                output["img_url"] = file_urls
                output["img_file"] = file_names
                output["img_id"] = i
                output['query'] = image_search_query
                output['caption'] = photo_caption
                if args.blip_caption:
                    output['blip_caption'] = get_blip_caption(os.path.join(img_dir, file_names[0]), captioner, img_processor).replace('photography', 'photo')

        output["speaker"] = agent_a["name"] if curr_speaker == 0 else agent_b['name']
        text_replaced_caption = replace_captions(output["text"], args)
        if not text_replaced_caption.isspace():
            if '[END]' in output["text"]:
                output["clean_text"] = text_replaced_caption
            else:
                output["clean_text"] = run_chatgpt(CASUAL_DIALOG_PROMPT % text_replaced_caption, 1, 100, 'chatgpt').strip()
        else:
            output["clean_text"] = ""
        
        output["dia_id"] = 'D%s:%s' % (curr_sess_id, i+1)
        session.append(output)

        # print(output)
        print("############ ", agent_a['name'] if curr_speaker == 0 else agent_b['name'], ': ', output["clean_text"])
        if "caption" in output:
            print("[ {} ]".format(output["blip_caption"]))
        
        # conv_so_far = conv_so_far + output["text"] + '\n'
        if "blip_caption" in output:
            conv_so_far = conv_so_far + output["clean_text"] + '[shares ' + output["blip_caption"] + ']' + '\n'
        else:
            conv_so_far = conv_so_far + output["clean_text"] + '\n'



        if output['text'].endswith('[END]'):
            if curr_speaker == 0:
                break_at_next_a = True
            else:
                break_at_next_b = True

        conv_so_far += f"\n{agent_b['name']}: " if curr_speaker == 0 else f"\n{agent_a['name']}: "
        curr_speaker = int(not curr_speaker)

    return session


def main():

    # get arguments
    args = parse_args()

    set_openai_key()

    args.emb_file = os.path.join(args.out_dir, args.emb_file)

    # create dataset directory
    if not os.path.exists(args.out_dir):
        os.makedirs(args.out_dir)
    logging.info("Dataset directory: %s" % args.out_dir)

    args.agent_a_file = os.path.join(args.out_dir, 'agent_a.json')
    args.agent_b_file = os.path.join(args.out_dir, 'agent_b.json')

    
    # Step 1: Get personalities for the agents; get a randomly selected sample from the MSC dataset and expand the few-liner personas into detailed personas.
    if args.persona:
        agent_a, agent_b = get_msc_persona(args)
        if agent_a is not None and agent_b is not None:
            save_agents([agent_a, agent_b], args)


    # Step 2: check if events exist; if not, generate event graphs for each of the agents 
    if args.events:

        agent_a, agent_b = load_agents(args)

        if ('graph' in agent_a and 'graph' in agent_b) and not args.overwrite_events:
            pass
        else:
            # if 'session_1_date_time' not in agent_a:
            start_date = get_random_date() # select a random date in 2022-2023
            end_date = start_date + timedelta(days=args.num_days)
            start_date = dateObj2Str(start_date)
            end_date = dateObj2Str(end_date)
            agent_a['events_start_date'] = start_date
            agent_b['events_start_date'] = start_date
            logging.info("Generating a random start date for the conversation")
            save_agents([agent_a, agent_b], args)

            
            agent_a_events = []
            agent_b_events = []

            logging.info("Generating events for Agent A")
            trials = 0
            while len(agent_a_events) < args.num_events:
                logging.info("(Re)trying to generate events with dense causal connections: trial %s" % trials)
                agent_a_events = get_events(agent_a, start_date, end_date, args)
                agent_a["graph"] = agent_a_events
                trials += 1

            logging.info("Generating events for Agent B")
            trials = 0
            while len(agent_b_events) < args.num_events:
                logging.info("(Re)trying to generate events with dense causal connections: trial %s" % trials)
                agent_b_events = get_events(agent_b, start_date, end_date, args)
                agent_b["graph"] = agent_b_events
            save_agents([agent_a, agent_b], args)

        # make sure keys are all lower case
        agent_a_events = agent_a['graph']
        agent_a_events = [{k.lower(): v for k,v in e.items()} for e in agent_a_events]
        agent_a["graph"] = agent_a_events
        agent_b_events = agent_b['graph']
        agent_b_events = [{k.lower(): v for k,v in e.items()} for e in agent_b_events]
        agent_b["graph"] = agent_b_events
        save_agents([agent_a, agent_b], args)

    # Step 3: 
    if args.session:

        agent_a, agent_b = load_agents(args)

        if args.blip_caption: # load an image captioner
            # init_model
            img_processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-large")
            captioner = BlipForConditionalGeneration.from_pretrained("Salesforce/blip-image-captioning-large").to("cuda")
        else:
            img_processor = None
            captioner = None

        # default start index is 1; if resuming conversation from a leter session, indicate in script arguments using --start-session
        for j in range(args.start_session, args.num_sessions+1):

            print("******************* SESSION %s ******************" % j)

            if 'session_%s' % j not in agent_a or args.overwrite_session:

                if j>1:
                    prev_date_time = datetimeStr2Obj(agent_a['session_%s_date_time' % (j-1)])
                    prev_date_time_string = agent_a['session_%s_date_time' % (j-1)]
                else:
                    prev_date_time, prev_date_time_string = None, None

                # get conversation date and time for each session
                curr_time = get_random_time() # timedelta object
                curr_date = get_session_date([agent_a['graph'], agent_b['graph']], args, prev_date=prev_date_time) # datetime object
                curr_date_time = curr_date + curr_time # datetime object
                
                relevant_events_a = get_relevant_events(agent_a['graph'],  curr_date_time, prev_date=prev_date_time)
                agent_a['events_session_%s' % j] = relevant_events_a
                relevant_events_b = get_relevant_events(agent_b['graph'],  curr_date_time, prev_date=prev_date_time)
                agent_b['events_session_%s' % j] = relevant_events_b

                if len(relevant_events_a) == 0 and len(relevant_events_b) == 0:
                    logging.info("Stoppping conversation because no more events available in KG.")
                    break

                curr_date_time_string = datetimeObj2Str(curr_date_time)
                agent_a['session_%s_date_time' % j] = curr_date_time_string
                agent_b['session_%s_date_time' % j] = curr_date_time_string
                save_agents([agent_a, agent_b], args)
                
                session = get_session(agent_a, agent_b, args,
                                      prev_date_time_string=prev_date_time_string, curr_date_time_string=curr_date_time_string, 
                                      curr_sess_id=j, captioner=captioner, img_processor=img_processor, reflection=args.reflection)
                
                agent_a['session_%s' % j] = session
                agent_b['session_%s' % j] = session

                save_agents([agent_a, agent_b], args)

            if 'session_%s_facts' % j not in agent_a or args.overwrite_session:

                facts = get_session_facts(args, agent_a, agent_b, j)

                agent_a['session_%s_facts' % j] = facts
                agent_b['session_%s_facts' % j] = facts

                print(" --------- Session %s Summary for Agent A---------" % (j))
                print(facts)

                save_agents([agent_a, agent_b], args)

            if args.reflection and ('session_%s_reflection' % j not in agent_a or args.overwrite_session):

                reflections = get_session_reflection(args, agent_a, agent_b, j)

                agent_a['session_%s_reflection' % j] = reflections['a']
                agent_b['session_%s_reflection' % j] = reflections['b']

                print(" --------- Session %s Reflection for Agent A---------" % (j))
                print(reflections)

                save_agents([agent_a, agent_b], args)

            if args.summary and ('session_%s_summary' % j not in agent_a or args.overwrite_session):

                summary = get_session_summary(agent_a['session_%s' % j], agent_a, agent_b, agent_a['session_%s_date_time' % j], 
                                              previous_summary=None if j==1 else agent_a['session_%s_summary' % (j-1)])

                agent_a['session_%s_summary' % j] = summary
                agent_b['session_%s_summary' % j] = summary

                save_agents([agent_a, agent_b], args)

    agent_a, agent_b = load_agents(args)
    convert_to_chat_html(agent_a, agent_b, outfile=os.path.join(args.out_dir, 'sessions.html'), use_events=args.events, img_dir=args.out_dir)


if __name__ == "__main__":
    main()